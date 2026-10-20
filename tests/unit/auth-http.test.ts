import { beforeEach, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { ApplicationError, RateLimitError } from "@/server/http/errors";
import { createSessionCredential } from "@/modules/auth/sessions";
import { AUTH_CHALLENGE_COOKIE_NAME } from "@/server/security/auth-csrf";
import { SESSION_COOKIE_NAME } from "@/modules/auth/session-format";

const mocks = vi.hoisted(() => ({ get: vi.fn(), login: vi.fn(), logout: vi.fn() }));
vi.mock("@/server/auth-runtime", () => ({ getAuthService: mocks.get }));
import { authChallenge, authMutation } from "@/server/auth-http";

const origin = "https://127.0.0.1:3000";
beforeEach(() => {
  vi.stubEnv("NODE_ENV", "development");
  vi.stubEnv("LIBRARYOS_LOCAL_HTTPS", "1");
  vi.stubEnv("AUTH_ORIGIN", origin);
  vi.stubEnv("AUTH_CSRF_KEY", "ab".repeat(32));
  vi.stubEnv("AUTH_RATE_LIMIT_KEY", "cd".repeat(32));
  mocks.get.mockReset().mockResolvedValue({ login: mocks.login, logout: mocks.logout });
  mocks.login.mockReset(); mocks.logout.mockReset().mockResolvedValue(undefined);
});

async function challenge(purpose = "login", session = "") {
  const response = await authChallenge(new NextRequest(`${origin}/api/v1/auth/challenge?purpose=${purpose}`, {
    headers: { "Sec-Fetch-Site": "same-origin", Cookie: `${SESSION_COOKIE_NAME}=${session}` },
  }));
  expect(response.status, await response.clone().text()).toBe(200);
  const nonce = response.headers.get("set-cookie")!.split(";")[0]!;
  const body = await response.json();
  return { response, nonce, csrf: body.data.csrfToken as string };
}

function mutation(nonce: string, csrf: string, body: string, session = "", extra = {}) {
  return new NextRequest(`${origin}/api/v1/auth/login`, { method: "POST", body,
    headers: { Origin: origin, "Content-Type": "application/json", "X-CSRF-Token": csrf,
      Cookie: `${nonce}; ${SESSION_COOKIE_NAME}=${session}`, ...extra } });
}

it("issues a no-store purpose-bound challenge with a private secure nonce", async () => {
  const { response, csrf, nonce } = await challenge();
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("set-cookie")).toMatch(/HttpOnly/);
  expect(response.headers.get("set-cookie")).toMatch(/Secure/);
  expect(csrf).not.toContain(nonce.split("=")[1]);
  expect(mocks.get).not.toHaveBeenCalled();
});

it("rejects cross-site bootstrap and mutations before database initialization", async () => {
  const response = await authChallenge(new NextRequest(`${origin}/api/v1/auth/challenge?purpose=login`, { headers: { "Sec-Fetch-Site": "cross-site" } }));
  expect(response.status).toBe(403);
  const { nonce, csrf } = await challenge();
  expect((await authMutation(mutation(nonce, csrf, "{}", "", { Origin: "https://evil.example" }), "login")).status).toBe(403);
  expect(mocks.get).not.toHaveBeenCalled();
});

it("projects the user only, sets secure cookies and ignores forwarded IP headers", async () => {
  const { nonce, csrf } = await challenge();
  const token = createSessionCredential().token;
  mocks.login.mockResolvedValue({ token, expiresAt: new Date(Date.now() + 60_000), user: { id: "abc", email: "a@example.com" } });
  const response = await authMutation(mutation(nonce, csrf, JSON.stringify({ email: "a@example.com", password: "secret" }), "", { "X-Forwarded-For": "8.8.8.8" }), "login");
  expect(response.status).toBe(200);
  expect(await response.text()).not.toContain(token);
  expect(mocks.login.mock.calls[0]?.[1]).toBe("127.0.0.1");
  expect(response.headers.get("set-cookie")).toContain(`${SESSION_COOKIE_NAME}=${token}`);
  expect(response.headers.get("set-cookie")).toContain("HttpOnly");
  expect(response.headers.get("set-cookie")).toContain(`${AUTH_CHALLENGE_COOKIE_NAME}=;`);
});

it("rejects malformed and oversized bodies before service initialization", async () => {
  const { nonce, csrf } = await challenge();
  for (const body of ["{", "x".repeat(16_385), JSON.stringify({ email: "a@example.com", password: "p", role: "admin" })]) {
    expect((await authMutation(mutation(nonce, csrf, body), "login")).status).toBe(400);
  }
  expect(mocks.get).not.toHaveBeenCalled();
});

it("preserves challenge cookies on failure and returns limiter retry metadata", async () => {
  const { nonce, csrf } = await challenge();
  mocks.login.mockRejectedValue(new RateLimitError(30));
  const response = await authMutation(mutation(nonce, csrf, JSON.stringify({ email: "a@example.com", password: "p" })), "login");
  expect(response.status).toBe(429);
  expect(response.headers.get("retry-after")).toBe("30");
  expect(response.headers.get("set-cookie")).toBeNull();
});

it("binds logout to its browser and clears cookies only after successful revocation", async () => {
  const token = createSessionCredential().token;
  const { nonce, csrf } = await challenge("logout", token);
  expect((await authMutation(mutation(nonce, csrf, "{}", createSessionCredential().token), "logout")).status).toBe(403);
  mocks.logout.mockRejectedValueOnce(new ApplicationError("SERVICE_UNAVAILABLE"));
  const failed = await authMutation(mutation(nonce, csrf, "{}", token), "logout");
  expect(failed.status).toBe(503); expect(failed.headers.get("set-cookie")).toBeNull();
  const response = await authMutation(mutation(nonce, csrf, "{}", token), "logout");
  expect(response.status).toBe(204);
  expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
  expect(mocks.logout).toHaveBeenLastCalledWith(token, expect.any(Object));
});

it("fails closed outside approved local development", async () => {
  vi.stubEnv("NODE_ENV", "production");
  const response = await authChallenge(new NextRequest(`${origin}/api/v1/auth/challenge?purpose=login`));
  expect(response.status).toBe(503);
  expect(mocks.get).not.toHaveBeenCalled();
});

it("does not enable recovery bootstrap merely because protocol purposes exist", async () => {
  const response = await authChallenge(new NextRequest(`${origin}/api/v1/auth/challenge?purpose=reset-password`, {
    headers: { "Sec-Fetch-Site": "same-origin" },
  }));
  expect(response.status).toBe(400);
  expect(response.headers.get("set-cookie")).toBeNull();
  expect(mocks.get).not.toHaveBeenCalled();
});
