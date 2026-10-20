import { afterEach, describe, expect, it, vi } from "vitest";
import { AUTH_CHALLENGE_LIFETIME_MS, clearedAuthChallengeCookie, createAuthCsrfProtection } from "@/server/security/auth-csrf";
import { createSessionCredential } from "@/modules/auth/sessions";

const origin = "https://127.0.0.1:3000";
const configuration = { origin, secret: Buffer.alloc(32, 3) };
const csrf = createAuthCsrfProtection(configuration);
function request(token: string, changes: Record<string, string> = {}) {
  return { method: "POST", headers: new Headers({ Origin: origin, "Content-Type": "application/json", "X-CSRF-Token": token, ...changes }) };
}
afterEach(() => { vi.useRealTimers(); });

describe("auth bootstrap CSRF", () => {
  it("isolates recovery requests and completion challenges from each other and login", () => {
    const purposes = ["login", "verification-request", "verify-email", "reset-request", "reset-password"] as const;
    for (const purpose of purposes) {
      const challenge = csrf.issue(purpose);
      for (const destination of purposes) {
        const assertion = () => csrf.assertMutation(request(challenge.token), challenge.cookie.value, destination);
        if (purpose === destination) expect(assertion).not.toThrow();
        else expect(assertion).toThrow();
      }
    }
  });
  it("uses an HttpOnly pre-session nonce without pretending to authenticate a user", () => {
    const challenge = csrf.issue("login");
    expect(challenge.cookie).toMatchObject({ name: "__Host-libraryos_auth_challenge", secure: true, httpOnly: true, sameSite: "strict", path: "/" });
    expect(challenge.cookie).not.toHaveProperty("domain");
    expect(challenge.token).not.toContain(challenge.cookie.value);
    expect(() => csrf.assertMutation(request(challenge.token), challenge.cookie.value, "login")).not.toThrow();
    expect(() => createAuthCsrfProtection(configuration).assertMutation(request(challenge.token), challenge.cookie.value, "login")).not.toThrow();
    expect(clearedAuthChallengeCookie()).toMatchObject({ value: "", maxAge: 0, expires: new Date(0) });
  });
  it("rejects missing/different cookies, foreign Origin, tampering and cross-purpose replay", () => {
    const challenge = csrf.issue("login");
    expect(() => csrf.assertMutation(request(challenge.token), null, "login")).toThrow();
    expect(() => csrf.assertMutation(request(challenge.token), createSessionCredential().token, "login")).toThrow();
    expect(() => csrf.assertMutation(request(challenge.token), challenge.cookie.value, "logout")).toThrow();
    expect(() => csrf.assertMutation(request(challenge.token, { Origin: "https://attacker.example" }), challenge.cookie.value, "login")).toThrow();
    expect(() => csrf.assertMutation(request(challenge.token, { "Content-Type": "text/plain" }), challenge.cookie.value, "login")).toThrow();
    expect(() => csrf.assertMutation(request(`${challenge.token}x`), challenge.cookie.value, "login")).toThrow();
    const missing = request(challenge.token);
    missing.headers.delete("Origin");
    expect(() => csrf.assertMutation(missing, challenge.cookie.value, "login")).toThrow();
  });
  it("binds logout to the actual cookie credential even when account eligibility has changed", () => {
    const session = createSessionCredential();
    const challenge = csrf.issue("logout", session.token);
    expect(() => csrf.assertMutation(request(challenge.token), challenge.cookie.value, "logout", session.token)).not.toThrow();
    expect(() => csrf.assertMutation(request(challenge.token), challenge.cookie.value, "logout", createSessionCredential().token)).toThrow();
    expect(() => csrf.assertMutation(request(challenge.token), challenge.cookie.value, "logout")).toThrow();
  });
  it("expires protocol challenges and rejects future-dated signatures", () => {
    vi.useFakeTimers();
    const now = Date.now();
    const challenge = csrf.issue("login");
    vi.setSystemTime(now + AUTH_CHALLENGE_LIFETIME_MS);
    expect(() => csrf.assertMutation(request(challenge.token), challenge.cookie.value, "login")).toThrow();
    vi.setSystemTime(now - 1000);
    expect(() => csrf.assertMutation(request(challenge.token), challenge.cookie.value, "login")).toThrow();
  });
});
