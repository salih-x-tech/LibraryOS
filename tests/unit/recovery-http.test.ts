import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { ApplicationError, RateLimitError } from "@/server/http/errors";
import { createActionToken } from "@/modules/auth/action-token-format";
const mocks = vi.hoisted(() => ({ get: vi.fn(), complete: vi.fn() }));
const queue = vi.hoisted(() => ({ get: vi.fn(), enqueue: vi.fn() }));
vi.mock("@/server/recovery-request-runtime", () => ({ getLocalRecoveryRequestQueue: queue.get }));
vi.mock("@/server/recovery-runtime", () => ({ getLocalRecoveryService: mocks.get }));
import { recoveryChallenge, recoveryCompletion, recoveryRequest } from "@/server/recovery-http";
const origin = "https://127.0.0.1:3000";
beforeEach(() => {
  vi.stubEnv("NODE_ENV", "development"); vi.stubEnv("LIBRARYOS_LOCAL_HTTPS", "1");
  vi.stubEnv("AUTH_ORIGIN", origin); vi.stubEnv("AUTH_CSRF_KEY", "ab".repeat(32)); vi.stubEnv("AUTH_RATE_LIMIT_KEY", "cd".repeat(32));
  vi.stubEnv("AUTH_RECOVERY_COMPLETION_HTTP", "1");
  vi.stubEnv("AUTH_RECOVERY_REQUEST_HTTP", "1");
  queue.get.mockReset().mockResolvedValue({ enqueue: queue.enqueue }); queue.enqueue.mockReset().mockResolvedValue(undefined);
  mocks.get.mockReset().mockResolvedValue({ complete: mocks.complete }); mocks.complete.mockReset().mockResolvedValue(undefined);
});

async function admissionChallenge(purpose = "reset-request") {
  const response = await recoveryChallenge(new NextRequest(`${origin}/api/v1/auth/recovery-challenge?purpose=${purpose}`,
    { headers: { "Sec-Fetch-Site": "same-origin" } }));
  expect(response.status).toBe(200);
  return { nonce: response.headers.get("set-cookie")!.split(";")[0]!, csrf: (await response.json()).data.csrfToken };
}
it("admits only a normalized email and returns a generic receipt without initializing delivery", async () => {
  const { nonce, csrf } = await admissionChallenge();
  const response = await recoveryRequest(request(nonce, csrf, JSON.stringify({ email: " Person@Example.com " }),
    { "X-Forwarded-For": "8.8.8.8" }), "reset-password");
  expect(response.status).toBe(202);
  expect((await response.json()).data).toEqual({ received: true });
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(queue.enqueue).toHaveBeenCalledWith("reset-password", "person@example.com", "127.0.0.1", expect.any(Object));
  expect(mocks.get).not.toHaveBeenCalled();
});
it("rejects admission authority fields, oversized bodies and completion challenges before queue access", async () => {
  const { nonce, csrf } = await admissionChallenge();
  for (const body of ["{", "x".repeat(16_385), JSON.stringify({ email: "person@example.com", role: "Owner" })]) {
    expect((await recoveryRequest(request(nonce, csrf, body), "reset-password")).status).toBe(400);
  }
  expect((await recoveryRequest(request(nonce, csrf, JSON.stringify({ email: "invalid" })), "reset-password")).status).toBe(422);
  const completion = await challenge();
  expect((await recoveryRequest(request(completion.nonce, completion.csrf, JSON.stringify({ email: "person@example.com" })), "reset-password")).status).toBe(403);
  expect(queue.get).not.toHaveBeenCalled();
});
it("keeps admission independently disabled and refuses production", async () => {
  vi.stubEnv("AUTH_RECOVERY_REQUEST_HTTP", "");
  expect((await recoveryRequest(request("", "", "{}"), "reset-password")).status).toBe(503);
  vi.stubEnv("AUTH_RECOVERY_REQUEST_HTTP", "1"); vi.stubEnv("NODE_ENV", "production");
  expect((await recoveryRequest(request("", "", "{}"), "reset-password")).status).toBe(503);
  expect(queue.get).not.toHaveBeenCalled();
});
it("preserves cookies on failed admission and reports shared limiter retry metadata", async () => {
  const { nonce, csrf } = await admissionChallenge("verification-request");
  queue.enqueue.mockRejectedValueOnce(new RateLimitError(15));
  const response = await recoveryRequest(request(nonce, csrf, JSON.stringify({ email: "person@example.com" })), "verify-email");
  expect(response.status).toBe(429); expect(response.headers.get("retry-after")).toBe("15");
  expect(response.headers.get("set-cookie")).toBeNull();
});
afterEach(() => vi.unstubAllEnvs());
async function challenge(purpose: "reset-password" | "verify-email" = "reset-password") {
  const response = await recoveryChallenge(new NextRequest(`${origin}/api/v1/auth/recovery-challenge?purpose=${purpose}`, { headers: { "Sec-Fetch-Site": "same-origin" } }));
  expect(response.status).toBe(200);
  return { nonce: response.headers.get("set-cookie")!.split(";")[0]!, csrf: (await response.json()).data.csrfToken };
}
function request(nonce: string, csrf: string, body: string, extra = {}) {
  return new NextRequest(`${origin}/api/v1/auth/reset-password`, { method: "POST", body,
    headers: { Origin: origin, "Content-Type": "application/json", Cookie: nonce, "X-CSRF-Token": csrf, ...extra } });
}
it("defaults to disabled and refuses production even with the switch set", async () => {
  vi.stubEnv("AUTH_RECOVERY_COMPLETION_HTTP", "");
  expect((await recoveryChallenge(new NextRequest(`${origin}/api/v1/auth/recovery-challenge?purpose=reset-password`))).status).toBe(503);
  vi.stubEnv("AUTH_RECOVERY_COMPLETION_HTTP", "1"); vi.stubEnv("NODE_ENV", "production");
  expect((await recoveryCompletion(request("", "", "{}"), "reset-password")).status).toBe(503);
  expect(mocks.get).not.toHaveBeenCalled();
});
it("rejects cross-site bootstrap and cross-purpose mutation before service initialization", async () => {
  expect((await recoveryChallenge(new NextRequest(`${origin}/api/v1/auth/recovery-challenge?purpose=reset-password`, { headers: { "Sec-Fetch-Site": "cross-site" } }))).status).toBe(403);
  const { nonce, csrf } = await challenge("verify-email");
  expect((await recoveryCompletion(request(nonce, csrf, "{}"), "reset-password")).status).toBe(403);
  expect(mocks.get).not.toHaveBeenCalled();
});
it("rejects unknown authority fields, invalid tokens and oversized streamed JSON before initialization", async () => {
  const { nonce, csrf } = await challenge();
  const token = createActionToken("reset-password").token;
  for (const body of ["{", "x".repeat(16_385), JSON.stringify({ token, password: "valid password phrase", role: "Owner" }), JSON.stringify({ token: "bad", password: "valid password phrase" })]) {
    expect((await recoveryCompletion(request(nonce, csrf, body), "reset-password")).status).toBe(400);
  }
  expect(mocks.get).not.toHaveBeenCalled();
});
it("clears cookies only after committed reset and never serializes credentials", async () => {
  const { nonce, csrf } = await challenge(); const token = createActionToken("reset-password").token;
  const response = await recoveryCompletion(request(nonce, csrf, JSON.stringify({ token, password: "valid password phrase" }), { "X-Forwarded-For": "8.8.8.8" }), "reset-password");
  expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.text()).not.toContain(token);
  expect(response.headers.get("set-cookie")).toContain("__Host-libraryos_session=;");
  expect(mocks.complete).toHaveBeenCalledWith("reset-password", token, "127.0.0.1", expect.any(Object), "valid password phrase");
});
it("preserves cookies after service failure and exposes real limiter retry metadata", async () => {
  const { nonce, csrf } = await challenge(); const body = JSON.stringify({ token: createActionToken("reset-password").token, password: "valid password phrase" });
  for (const failure of [new ApplicationError("SERVICE_UNAVAILABLE"), new RateLimitError(20)]) {
    mocks.complete.mockRejectedValueOnce(failure);
    const response = await recoveryCompletion(request(nonce, csrf, body), "reset-password");
    expect(response.status).toBe(failure instanceof RateLimitError ? 429 : 503);
    expect(response.headers.get("set-cookie")).toBeNull();
    if (failure instanceof RateLimitError) expect(response.headers.get("retry-after")).toBe("20");
  }
});
it("does not clear an unrelated browser cookie during email verification", async () => {
  const { nonce, csrf } = await challenge("verify-email");
  const response = await recoveryCompletion(request(nonce, csrf, JSON.stringify({ token: createActionToken("verify-email").token })), "verify-email");
  expect(response.status).toBe(200); expect(response.headers.get("set-cookie")).not.toContain("__Host-libraryos_session");
});
