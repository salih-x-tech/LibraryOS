import "server-only";
import { NextRequest, NextResponse } from "next/server";
import { readLocalAuthConfiguration } from "./auth-config";
import { getAuthService } from "./auth-runtime";
import { ApplicationError } from "./http/errors";
import { createRequestContext, errorResponse, noContentResponse, successResponse } from "./http/responses";
import { AUTH_CHALLENGE_COOKIE_NAME, clearedAuthChallengeCookie, createAuthCsrfProtection } from "./security/auth-csrf";
import { SESSION_COOKIE_NAME } from "@/modules/auth/session-format";
import { clearedSessionCookie, sessionCookie } from "@/modules/auth/sessions";
import { validateLoginInput } from "@/modules/auth/validation";

function configuration() {
  let config;
  try { config = readLocalAuthConfiguration(); } catch { throw new ApplicationError("SERVICE_UNAVAILABLE"); }
  // Next normalizes loopback request URLs to localhost. Trust only explicit
  // launcher configuration and the browser Origin checks below, never that URL.
  return { config, csrf: createAuthCsrfProtection({ origin: config.origin, secret: config.csrfKey }) };
}

// Bound actual streamed bytes, including chunked requests with no Content-Length.
async function jsonBody(request: NextRequest): Promise<unknown> {
  const reader = request.body?.getReader();
  if (!reader) throw new ApplicationError("BAD_REQUEST");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > 16_384) { await reader.cancel(); throw new ApplicationError("BAD_REQUEST"); }
      chunks.push(next.value);
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
  } catch { throw new ApplicationError("BAD_REQUEST"); }
  finally { reader.releaseLock(); }
}

export async function authChallenge(request: NextRequest): Promise<Response> {
  const context = createRequestContext();
  try {
    const { config, csrf } = configuration();
    const origin = request.headers.get("Origin");
    if ((origin !== null && origin !== config.origin) || request.headers.get("Sec-Fetch-Site") !== "same-origin") {
      throw new ApplicationError("FORBIDDEN");
    }
    const purpose = request.nextUrl.searchParams.get("purpose");
    if (purpose !== "login" && purpose !== "logout") throw new ApplicationError("BAD_REQUEST");
    const challenge = csrf.issue(purpose, request.cookies.get(SESSION_COOKIE_NAME)?.value);
    const base = successResponse({ csrfToken: challenge.token }, context);
    const response = new NextResponse(base.body, { status: base.status, headers: base.headers });
    response.cookies.set(challenge.cookie);
    return response;
  } catch (error) { return errorResponse(error, context); }
}

export async function authMutation(request: NextRequest, purpose: "login" | "logout"): Promise<Response> {
  const context = createRequestContext();
  try {
    const { csrf } = configuration();
    const token = request.cookies.get(SESSION_COOKIE_NAME)?.value ?? "";
    csrf.assertMutation(request, request.cookies.get(AUTH_CHALLENGE_COOKIE_NAME)?.value ?? null, purpose, token);
    const body = await jsonBody(request);
    if (purpose === "login") validateLoginInput(body);
    else if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 0) throw new ApplicationError("BAD_REQUEST");
    const service = await getAuthService();
    if (purpose === "login") {
      // Launcher binds only 127.0.0.1; all forwarded IP headers are ignored.
      const result = await service.login(body, "127.0.0.1", context);
      const base = successResponse({ user: { id: result.user.id, email: result.user.email } }, context);
      const response = new NextResponse(base.body, { status: base.status, headers: base.headers });
      response.cookies.set(sessionCookie(result.token, result.expiresAt));
      response.cookies.set(clearedAuthChallengeCookie());
      return response;
    }
    await service.logout(token, context);
    const base = noContentResponse(context);
    const response = new NextResponse(null, { status: base.status, headers: base.headers });
    response.cookies.set(clearedSessionCookie());
    response.cookies.set(clearedAuthChallengeCookie());
    return response;
  } catch (error) { return errorResponse(error, context); }
}
