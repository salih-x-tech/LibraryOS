import "server-only";
import { NextRequest, NextResponse } from "next/server";
import { readLocalAuthConfiguration } from "./auth-config";
import { getLocalRecoveryService } from "./recovery-runtime";
import { ApplicationError } from "./http/errors";
import { readBoundedJson } from "./http/json-body";
import { createRequestContext, errorResponse, successResponse } from "./http/responses";
import { AUTH_CHALLENGE_COOKIE_NAME, clearedAuthChallengeCookie, createAuthCsrfProtection } from "./security/auth-csrf";
import { clearedSessionCookie } from "@/modules/auth/sessions";
import { MAX_PASSWORD_BYTES } from "@/modules/auth/password-format";
import { hashActionToken, type ActionTokenPurpose } from "@/modules/auth/action-token-format";

function configuration() {
  try {
    const config = readLocalAuthConfiguration();
    if (process.env.AUTH_RECOVERY_COMPLETION_HTTP !== "1") throw new Error();
    return { config, csrf: createAuthCsrfProtection({ origin: config.origin, secret: config.csrfKey }) };
  } catch { throw new ApplicationError("SERVICE_UNAVAILABLE"); }
}
function purposeOf(value: string | null): ActionTokenPurpose {
  if (value !== "verify-email" && value !== "reset-password") throw new ApplicationError("BAD_REQUEST");
  return value;
}

export async function recoveryChallenge(request: NextRequest): Promise<Response> {
  const context = createRequestContext();
  try {
    const { config, csrf } = configuration();
    if (request.headers.get("Sec-Fetch-Site") !== "same-origin"
      || (request.headers.has("Origin") && request.headers.get("Origin") !== config.origin)) throw new ApplicationError("FORBIDDEN");
    const challenge = csrf.issue(purposeOf(request.nextUrl.searchParams.get("purpose")));
    const base = successResponse({ csrfToken: challenge.token }, context);
    const response = new NextResponse(base.body, { status: base.status, headers: base.headers });
    response.cookies.set(challenge.cookie);
    return response;
  } catch (error) { return errorResponse(error, context); }
}

export async function recoveryCompletion(request: NextRequest, purpose: ActionTokenPurpose): Promise<Response> {
  const context = createRequestContext();
  try {
    purposeOf(purpose);
    const { csrf } = configuration();
    csrf.assertMutation(request, request.cookies.get(AUTH_CHALLENGE_COOKIE_NAME)?.value ?? null, purpose);
    const value = await readBoundedJson(request);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new ApplicationError("BAD_REQUEST");
    const body = value as Record<string, unknown>;
    const expected = purpose === "reset-password" ? ["token", "password"] : ["token"];
    if (Object.keys(body).length !== expected.length || expected.some((field) => !Object.hasOwn(body, field))
      || typeof body.token !== "string" || !hashActionToken(purpose, body.token)) throw new ApplicationError("BAD_REQUEST");
    if (purpose === "reset-password" && (typeof body.password !== "string" || !body.password.isWellFormed()
      || !body.password || Buffer.byteLength(body.password) > MAX_PASSWORD_BYTES)) throw new ApplicationError("BAD_REQUEST");
    const service = await getLocalRecoveryService();
    await service.complete(purpose, body.token, "127.0.0.1", context, body.password);
    const base = successResponse({ completed: true }, context);
    const response = new NextResponse(base.body, { status: base.status, headers: base.headers });
    response.cookies.set(clearedAuthChallengeCookie());
    // Reset invalidates every session; clear this browser only after commit.
    if (purpose === "reset-password") response.cookies.set(clearedSessionCookie());
    return response;
  } catch (error) { return errorResponse(error, context); }
}
