import "server-only";
import type { NextRequest } from "next/server";
import { readLocalAuthConfiguration } from "./auth-config";
import { getAuthService } from "./auth-runtime";
import { getDatabaseConnection } from "./db/connection";
import { createProfileService } from "@/modules/auth/profile-service";
import { SESSION_COOKIE_NAME } from "@/modules/auth/session-format";
import { createCsrfProtection } from "./security/csrf";
import { ApplicationError } from "./http/errors";
import { readBoundedJson } from "./http/json-body";
import { createRequestContext, errorResponse, successResponse } from "./http/responses";

export async function profileHttp(request: NextRequest): Promise<Response> {
  const context = createRequestContext();
  try {
    let config;
    try { config = readLocalAuthConfiguration(); } catch { throw new ApplicationError("SERVICE_UNAVAILABLE"); }
    const csrf = createCsrfProtection({ origin: config.origin, secret: config.csrfKey });
    const token = request.cookies.get(SESSION_COOKIE_NAME)?.value ?? "";
    const auth = await getAuthService(); // Includes read-only storage readiness.
    const principal = await auth.resolveSession(token);
    if (!principal) throw new ApplicationError("UNAUTHENTICATED");
    const service = createProfileService(await getDatabaseConnection());
    if (request.method === "GET") {
      if (request.headers.get("Sec-Fetch-Site") !== "same-origin"
        || (request.headers.has("Origin") && request.headers.get("Origin") !== config.origin)) throw new ApplicationError("FORBIDDEN");
      const result = await service.read(token);
      return successResponse({ user: result.user, csrfToken: csrf.issue(result.principal) }, context);
    }
    csrf.assertMutation(request, principal);
    return successResponse({ user: await service.update(token, await readBoundedJson(request), context) }, context);
  } catch (error) { return errorResponse(error instanceof ApplicationError ? error : new ApplicationError("SERVICE_UNAVAILABLE"), context); }
}
