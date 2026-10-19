import { describe, expect, it } from "vitest";
import { clearedSessionCookie, createSessionCredential, hashSessionToken, sessionCookie } from "@/modules/auth/sessions";

describe("opaque session credentials and cookies", () => {
  it("generates independent 256-bit canonical tokens and stable one-way hashes", () => {
    const first = createSessionCredential();
    const second = createSessionCredential();
    expect(first.token).not.toBe(second.token);
    expect(Buffer.from(first.token, "base64url")).toHaveLength(32);
    expect(first.tokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(hashSessionToken(first.token)).toBe(first.tokenHash);
    expect(Object.isFrozen(first)).toBe(true);
  });
  it("rejects malformed/noncanonical tokens without throwing sensitive errors", () => {
    for (const token of ["", "short", "a".repeat(1000), "A".repeat(42) + "B", "A".repeat(43) + "=", "\r\nCookie: forged"]) {
      expect(hashSessionToken(token)).toBeNull();
    }
  });
  it("uses host-only secure HttpOnly cookies and the caller's explicit expiry", () => {
    const credential = createSessionCredential();
    const expires = new Date(Date.now() + 60_000);
    const cookie = sessionCookie(credential.token, expires);
    expect(cookie).toEqual({ name: "__Host-libraryos_session", value: credential.token, secure: true, httpOnly: true, sameSite: "lax", path: "/", expires });
    expect(cookie).not.toHaveProperty("domain");
    expires.setTime(0);
    expect(cookie.expires.getTime()).toBeGreaterThan(Date.now());
    expect(() => sessionCookie(credential.token, new Date(0))).toThrow();
    expect(() => sessionCookie(credential.token, new Date(NaN))).toThrow();
    expect(() => sessionCookie("invalid", new Date(Date.now() + 60_000))).toThrow();
  });
  it("clears the same protected cookie without extending its lifetime", () => {
    expect(clearedSessionCookie()).toEqual({ name: "__Host-libraryos_session", value: "", secure: true, httpOnly: true, sameSite: "lax", path: "/", expires: new Date(0), maxAge: 0 });
  });
});
