import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { SESSION_COOKIE_NAME, SESSION_TOKEN_PATTERN } from "./session-format";

const tokenPattern = new RegExp(SESSION_TOKEN_PATTERN);

export function hashSessionToken(token: string): string | null {
  if (typeof token !== "string" || !tokenPattern.test(token)) return null;
  return createHash("sha256").update(token).digest("hex");
}

// Return only to server code. Persist tokenHash, never this credential object.
export function createSessionCredential(): Readonly<{ token: string; tokenHash: string }> {
  const token = randomBytes(32).toString("base64url");
  return Object.freeze({ token, tokenHash: createHash("sha256").update(token).digest("hex") });
}

export function sessionCookie(token: string, expiresAt: Date) {
  if (!hashSessionToken(token) || !(expiresAt instanceof Date) || !Number.isFinite(expiresAt.getTime()) || expiresAt.getTime() <= Date.now()) {
    throw new Error("A valid session token and explicit future expiry are required.");
  }
  return {
    name: SESSION_COOKIE_NAME, value: token, httpOnly: true, secure: true,
    sameSite: "lax", path: "/", expires: new Date(expiresAt.getTime()),
  } as const;
}

// Future logout must first revoke the database session, then set this cookie.
export function clearedSessionCookie() {
  return {
    name: SESSION_COOKIE_NAME, value: "", httpOnly: true, secure: true,
    sameSite: "lax", path: "/", expires: new Date(0), maxAge: 0,
  } as const;
}
