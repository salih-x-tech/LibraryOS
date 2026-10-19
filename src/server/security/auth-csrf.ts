import "server-only";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { ApplicationError } from "@/server/http/errors";
import { hashSessionToken } from "@/modules/auth/sessions";
import { SESSION_TOKEN_PATTERN } from "@/modules/auth/session-format";
import { CSRF_HEADER_NAME, createCsrfProtection, type CsrfConfiguration } from "./csrf";

export const AUTH_CHALLENGE_COOKIE_NAME = "__Host-libraryos_auth_challenge";
// Short-lived protocol nonce, not an authenticated account/session lifetime.
export const AUTH_CHALLENGE_LIFETIME_MS = 5 * 60_000;
type AuthPurpose = "login" | "logout";
const noncePattern = new RegExp(SESSION_TOKEN_PATTERN);
const signedPattern = /^v1\.([1-9][0-9]{12})\.([A-Za-z0-9_-]{42}[AEIMQUYcgkosw048])$/;

export function createAuthCsrfProtection(configuration: CsrfConfiguration) {
  createCsrfProtection(configuration); // shared canonical HTTPS/key validation
  const origin = configuration.origin;
  const key = Buffer.from(configuration.secret);

  function signature(purpose: AuthPurpose, nonce: string, expires: number, sessionToken?: string): Buffer {
    return createHmac("sha256", key).update(JSON.stringify([
      "libraryos.auth-csrf.v1", origin, purpose, nonce, expires,
      purpose === "logout" ? hashSessionToken(sessionToken ?? "") ?? "no-session" : "pre-authentication",
    ])).digest();
  }

  function issue(purpose: AuthPurpose, sessionToken?: string) {
    if (purpose !== "login" && purpose !== "logout") throw new Error("Invalid auth challenge purpose.");
    const nonce = randomBytes(32).toString("base64url");
    const expires = Date.now() + AUTH_CHALLENGE_LIFETIME_MS;
    return {
      token: `v1.${expires}.${signature(purpose, nonce, expires, sessionToken).toString("base64url")}`,
      cookie: { name: AUTH_CHALLENGE_COOKIE_NAME, value: nonce, secure: true, httpOnly: true,
        sameSite: "strict", path: "/", expires: new Date(expires) } as const,
    };
  }

  function assertMutation(request: Pick<Request, "method" | "headers">, nonce: string | null, purpose: AuthPurpose, sessionToken?: string): void {
    if (purpose !== "login" && purpose !== "logout") throw new Error("Invalid auth challenge purpose.");
    if (request.method !== "POST") throw new ApplicationError("BAD_REQUEST");
    const token = request.headers.get(CSRF_HEADER_NAME);
    const parsed = token && token.length <= 64 ? signedPattern.exec(token) : null;
    const expires = Number(parsed?.[1]);
    const supplied = parsed?.[2];
    if (request.headers.get("Origin") !== origin
      || request.headers.get("Content-Type")?.split(";")[0]?.trim().toLowerCase() !== "application/json"
      || !nonce || nonce.length !== 43 || !noncePattern.test(nonce) || !supplied || !Number.isSafeInteger(expires)
      || expires <= Date.now() || expires > Date.now() + AUTH_CHALLENGE_LIFETIME_MS
      || !timingSafeEqual(signature(purpose, nonce, expires, sessionToken), Buffer.from(supplied, "base64url"))) {
      throw new ApplicationError("FORBIDDEN");
    }
  }

  return Object.freeze({ issue, assertMutation });
}

export function clearedAuthChallengeCookie() {
  return { name: AUTH_CHALLENGE_COOKIE_NAME, value: "", secure: true, httpOnly: true,
    sameSite: "strict", path: "/", expires: new Date(0), maxAge: 0 } as const;
}
