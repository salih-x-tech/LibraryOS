import "server-only";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { SessionPrincipal } from "@/modules/auth/session-service";
import { ApplicationError } from "@/server/http/errors";

const tokenPart = "[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]";
const tokenFormat = new RegExp(`^v1\\.(${tokenPart})\\.(${tokenPart})$`);
export const CSRF_HEADER_NAME = "X-CSRF-Token";

type MutationRequest = Pick<Request, "method" | "headers">;
export type CsrfConfiguration = Readonly<{ origin: string; secret: Uint8Array }>;

function validPrincipal(principal: SessionPrincipal): boolean {
  return principal !== null && typeof principal === "object"
    && /^[a-f0-9]{24}$/.test(principal.sessionId) && /^[a-f0-9]{24}$/.test(principal.userId)
    && Number.isSafeInteger(principal.sessionVersion) && principal.sessionVersion >= 0
    && Number.isSafeInteger(principal.authorizationVersion) && principal.authorizationVersion >= 0;
}

function forbidden(): never { throw new ApplicationError("FORBIDDEN"); }

export function createCsrfProtection(configuration: CsrfConfiguration) {
  try {
    const url = new URL(configuration.origin);
    if (url.protocol !== "https:" || url.origin !== configuration.origin) throw new Error();
    if (!(configuration.secret instanceof Uint8Array) || configuration.secret.byteLength < 32) throw new Error();
  } catch {
    throw new Error("CSRF protection requires a canonical HTTPS origin and at least 32 secret bytes.");
  }
  // Snapshot server configuration; never derive trust from Host/Forwarded headers.
  const origin = configuration.origin;
  const key = Buffer.from(configuration.secret);

  function signature(principal: SessionPrincipal, nonce: string): Buffer {
    return createHmac("sha256", key).update(JSON.stringify([
      "libraryos.csrf.v1", origin, principal.userId, principal.sessionId,
      principal.sessionVersion, principal.authorizationVersion, nonce,
    ])).digest();
  }

  function issue(principal: SessionPrincipal): string {
    if (!validPrincipal(principal)) throw new ApplicationError("UNAUTHENTICATED");
    const nonce = randomBytes(32).toString("base64url");
    return `v1.${nonce}.${signature(principal, nonce).toString("base64url")}`;
  }

  function assertMutation(request: MutationRequest, principal: SessionPrincipal | null): void {
    // This function does not resolve a session: the caller must do that afresh.
    if (!principal || !validPrincipal(principal)) throw new ApplicationError("UNAUTHENTICATED");
    if (!["POST", "PUT", "PATCH", "DELETE"].includes(request.method)) throw new ApplicationError("BAD_REQUEST");
    if (request.headers.get("Origin") !== origin) forbidden();
    if (request.headers.get("Content-Type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") forbidden();
    const token = request.headers.get(CSRF_HEADER_NAME);
    if (!token || token.length !== 90) forbidden();
    const parsed = tokenFormat.exec(token);
    const nonce = parsed?.[1];
    const suppliedSignature = parsed?.[2];
    if (!nonce || !suppliedSignature) forbidden();
    const actual = Buffer.from(suppliedSignature, "base64url");
    if (!timingSafeEqual(signature(principal, nonce), actual)) forbidden();
  }

  return Object.freeze({ issue, assertMutation });
}
