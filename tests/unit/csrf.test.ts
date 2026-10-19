import { describe, expect, it } from "vitest";
import { CSRF_HEADER_NAME, createCsrfProtection } from "@/server/security/csrf";
import type { SessionPrincipal } from "@/modules/auth/session-service";
import { createRequestContext, errorResponse } from "@/server/http/responses";

const origin = "https://libraryos.example";
const key = Buffer.alloc(32, 1); // synthetic fixture only
const principal: SessionPrincipal = {
  userId: "0123456789abcdef01234567", sessionId: "1123456789abcdef01234567",
  sessionVersion: 2, authorizationVersion: 3,
};
const protection = createCsrfProtection({ origin, secret: key });
function request(token: string, overrides: Record<string, string> = {}, method = "POST") {
  return { method, headers: new Headers({ Origin: origin, "Content-Type": "application/json", [CSRF_HEADER_NAME]: token, ...overrides }) };
}

describe("session-bound CSRF and trusted Origin", () => {
  it("accepts tokens only for the same session and server configuration across replicas", () => {
    const token = protection.issue(principal);
    expect(token).not.toContain(principal.sessionId);
    expect(protection.issue(principal)).not.toBe(token);
    const replica = createCsrfProtection({ origin, secret: Buffer.alloc(32, 1) });
    expect(() => replica.assertMutation(request(token), principal)).not.toThrow();
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      expect(() => protection.assertMutation(request(token, {}, method), principal)).not.toThrow();
    }
  });
  it("rejects a different user, rotated session or changed authorization/session version", () => {
    const token = protection.issue(principal);
    for (const other of [
      { ...principal, userId: "2123456789abcdef01234567" }, { ...principal, sessionId: "3123456789abcdef01234567" },
      { ...principal, sessionVersion: 4 }, { ...principal, authorizationVersion: 4 },
    ]) expect(() => protection.assertMutation(request(token), other)).toThrow("Access is denied.");
    expect(() => createCsrfProtection({ origin, secret: Buffer.alloc(32, 2) }).assertMutation(request(token), principal)).toThrow();
    const otherOrigin = "https://other.libraryos.example";
    expect(() => createCsrfProtection({ origin: otherOrigin, secret: key })
      .assertMutation(request(token, { Origin: otherOrigin }), principal)).toThrow();
  });
  it("rejects null, missing, foreign, lookalike and noncanonical Origins despite valid tokens", () => {
    const token = protection.issue(principal);
    for (const value of ["null", "", "https://attacker.example", `${origin}.attacker.example`, "https://sub.libraryos.example",
      "http://libraryos.example", `${origin}:444`, `${origin}/`, `${origin}/path`, `${origin}, https://attacker.example`]) {
      expect(() => protection.assertMutation(request(token, { Origin: value }), principal)).toThrow("Access is denied.");
    }
    const missing = request(token, { Host: "libraryos.example", "X-Forwarded-Host": "libraryos.example", Referer: `${origin}/` });
    missing.headers.delete("Origin");
    expect(() => protection.assertMutation(missing, principal)).toThrow();
  });
  it("rejects absent, oversized, duplicate, malformed and tampered tokens", () => {
    const token = protection.issue(principal);
    for (const value of ["", "a".repeat(10_000), token.slice(0, -1), `${token}=`, token.replace("v1", "v2"),
      `v1.${token[3] === "A" ? "B" : "A"}${token.slice(4)}`, `${token}, ${token}`, `${token.slice(0, -1)}B`]) {
      expect(() => protection.assertMutation(request(value), principal)).toThrow();
    }
    const absent = request(token);
    absent.headers.delete(CSRF_HEADER_NAME);
    expect(() => protection.assertMutation(absent, principal)).toThrow();
    const duplicate = request(token);
    duplicate.headers.append(CSRF_HEADER_NAME, token);
    expect(() => protection.assertMutation(duplicate, principal)).toThrow();
  });
  it("refuses cookie-only/form submissions and unsupported method usage", () => {
    const token = protection.issue(principal);
    for (const type of ["", "text/plain", "application/x-www-form-urlencoded", "multipart/form-data", "application/json, text/plain"]) {
      expect(() => protection.assertMutation(request(token, { "Content-Type": type }), principal)).toThrow();
    }
    expect(() => protection.assertMutation(request(token, { "Content-Type": "application/json; charset=utf-8" }), principal)).not.toThrow();
    for (const method of ["GET", "HEAD", "OPTIONS", "TRACE", "post"]) {
      expect(() => protection.assertMutation(request(token, {}, method), principal)).toThrow("The request is malformed.");
    }
    const cookieOnly = request(token, { Cookie: `csrf=${token}` });
    cookieOnly.headers.delete(CSRF_HEADER_NAME);
    expect(() => protection.assertMutation(cookieOnly, principal)).toThrow();
  });
  it("requires an explicit secure origin/secret and snapshots the caller's configuration", () => {
    for (const invalidOrigin of ["", "http://localhost:3000", "null", "*", `${origin}/`, `${origin}/path`, `${origin}?x=1`, "https://user:pass@libraryos.example"]) {
      expect(() => createCsrfProtection({ origin: invalidOrigin, secret: key })).toThrow("canonical HTTPS origin");
    }
    expect(() => createCsrfProtection({ origin, secret: Buffer.alloc(31) })).toThrow();
    const configuration = { origin, secret: Buffer.alloc(32, 3) };
    const instance = createCsrfProtection(configuration);
    const token = instance.issue(principal);
    configuration.origin = "https://attacker.example";
    configuration.secret.fill(9);
    expect(() => instance.assertMutation(request(token), principal)).not.toThrow();
  });
  it("requires a fresh authenticated principal and returns sanitized errors", async () => {
    const token = protection.issue(principal);
    expect(() => protection.assertMutation(request(token), null)).toThrow("Authentication is required.");
    expect(() => protection.issue({ ...principal, sessionId: "invalid" })).toThrow();
    try {
      protection.assertMutation(request(token, { Origin: "https://private.attacker.example" }), principal);
      expect.fail("Expected rejection");
    } catch (error) {
      const response = errorResponse(error, createRequestContext());
      expect(response.status).toBe(403);
      const body = await response.text();
      expect(body).not.toContain(token);
      expect(body).not.toContain("private.attacker");
    }
  });
});
