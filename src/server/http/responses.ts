import "server-only";
import { randomUUID } from "node:crypto";
import { DatabaseConnectionError } from "@/server/db/connection";
import { ApplicationError, describeError, FieldValidationError, RateLimitError } from "./errors";

export type JsonValue = string | number | boolean | null | readonly JsonValue[] | { readonly [key: string]: JsonValue };

// Generate once at the entry point and reuse for the response and safe logs.
// Do not trust an incoming request ID as an internal correlation identifier.
export function createRequestContext() {
  return Object.freeze({ requestId: randomUUID() });
}

export type RequestContext = ReturnType<typeof createRequestContext>;

function headers(context: RequestContext): HeadersInit {
  return { "Cache-Control": "no-store", "X-Request-Id": context.requestId };
}

// Callers must explicitly project safe DTOs. Never pass database documents.
export function successResponse<T extends JsonValue>(data: T, context: RequestContext): Response {
  return Response.json({ data, meta: { requestId: context.requestId } }, { status: 200, headers: headers(context) });
}

export function listResponse<T extends JsonValue>(data: readonly T[], nextCursor: string | null, context: RequestContext): Response {
  return Response.json({ data, meta: { requestId: context.requestId, nextCursor } }, {
    status: 200, headers: headers(context),
  });
}

export function acceptedResponse<T extends JsonValue>(data: T, context: RequestContext): Response {
  return Response.json({ data, meta: { requestId: context.requestId } }, { status: 202, headers: headers(context) });
}

export function noContentResponse(context: RequestContext): Response {
  return new Response(null, { status: 204, headers: headers(context) });
}

export function createdResponse<T extends JsonValue>(data: T, location: string, context: RequestContext): Response {
  // Only local API resource paths; never a client-controlled redirect target.
  if (!/^\/api\/v1\/[A-Za-z0-9_./~-]+$/.test(location) || location.includes("..")) {
    throw new Error("Creation Location must be a local API resource path.");
  }
  return Response.json({ data, meta: { requestId: context.requestId } }, {
    status: 201, headers: { ...headers(context), Location: location },
  });
}

export function errorResponse(error: unknown, context: RequestContext): Response {
  const mapped = error instanceof DatabaseConnectionError ? new ApplicationError("SERVICE_UNAVAILABLE") : error;
  // A 429 requires a real limiter decision, including a retry delay.
  const described = describeError(mapped);
  const { status, code, message } = described.code === "RATE_LIMITED" && !(error instanceof RateLimitError)
    ? describeError(undefined) : described;
  const responseHeaders = new Headers(headers(context));
  if (error instanceof RateLimitError) responseHeaders.set("Retry-After", String(error.retryAfterSeconds));
  const fields = error instanceof FieldValidationError ? error.fields : [];
  return Response.json({ error: { code, message, fields }, meta: { requestId: context.requestId } }, {
    status, headers: responseHeaders,
  });
}
