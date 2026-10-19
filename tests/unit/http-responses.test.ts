import { describe, expect, it } from "vitest";
import { ApplicationError, FieldValidationError, RateLimitError, type FieldIssue } from "@/server/http/errors";
import { acceptedResponse, noContentResponse, createdResponse, createRequestContext, errorResponse, successResponse } from "@/server/http/responses";
import { DatabaseConnectionError } from "@/server/db/connection";

describe("HTTP response boundaries", () => {
  it("returns accepted JSON and bodyless no-content responses", async () => {
    const context = createRequestContext();
    const accepted = acceptedResponse({ id: "job" }, context);
    expect(accepted.status).toBe(202);
    expect(await accepted.json()).toEqual({ data: { id: "job" }, meta: context });
    const empty = noContentResponse(context);
    expect(empty.status).toBe(204);
    expect(await empty.text()).toBe("");
    expect(empty.headers.get("content-type")).toBeNull();
    expect(empty.headers.get("cache-control")).toBe("no-store");
  });

  it("returns only declared validation fields and fixed codes", async () => {
    const issues = [{ field: "name", code: "REQUIRED", value: "private" }] as const;
    const error = new FieldValidationError(["name"], issues);
    const response = errorResponse(error, createRequestContext());
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ error: { fields: [{ field: "name", code: "REQUIRED" }] } });
    expect(Object.isFrozen(error.fields)).toBe(true);
    expect(Object.isFrozen(error.fields[0])).toBe(true);
  });

  it("rejects undeclared fields, unsafe paths, arbitrary messages and excessive issues", () => {
    expect(() => new FieldValidationError(["name"], [{ field: "secret", code: "INVALID" }])).toThrow();
    expect(() => new FieldValidationError(["__proto__"], [])).toThrow();
    expect(() => new FieldValidationError(["name"], [{ field: "name", code: "private" } as unknown as FieldIssue])).toThrow();
    expect(() => new FieldValidationError(["name"], Array.from({ length: 51 }, () => ({ field: "name", code: "INVALID" as const })))).toThrow();
  });

  it("requires an explicit limiter retry delay and returns Retry-After", async () => {
    const response = errorResponse(new RateLimitError(42), createRequestContext());
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("42");
    expect(await response.json()).toMatchObject({ error: { code: "RATE_LIMITED" } });
    for (const delay of [0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => new RateLimitError(delay)).toThrow();
    }
    expect(errorResponse(new ApplicationError("RATE_LIMITED"), createRequestContext()).status).toBe(500);
  });
  it("creates independent server-generated request IDs", () => {
    const context = createRequestContext();
    expect(context.requestId).toMatch(/^[a-f0-9-]{36}$/);
    expect(createRequestContext().requestId).not.toBe(context.requestId);
    expect(Object.isFrozen(context)).toBe(true);
  });

  it("returns explicit DTOs with matching correlation headers and no caching", async () => {
    const context = createRequestContext();
    const response = successResponse({ id: "public-id", enabled: true }, context);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-request-id")).toBe(context.requestId);
    expect(await response.json()).toEqual({ data: { id: "public-id", enabled: true }, meta: context });
  });

  it("includes a local Location for creation and rejects unsafe destinations", () => {
    const context = createRequestContext();
    const response = createdResponse({ id: "123" }, "/api/v1/organizations/123", context);
    expect(response.status).toBe(201);
    expect(response.headers.get("location")).toBe("/api/v1/organizations/123");
    for (const location of ["https://example.com", "//example.com", "/api/v1/../secret", "/api/v1/a\r\nInjected: yes"]) {
      expect(() => createdResponse({}, location, context)).toThrow();
    }
  });

  it.each([
    ["UNAUTHENTICATED", 401], ["FORBIDDEN", 403], ["NOT_FOUND", 404],
    ["STALE_VERSION", 409], ["QUOTA_EXCEEDED", 409], ["VALIDATION_FAILED", 422],
    ["PRECONDITION_REQUIRED", 428], ["SERVICE_UNAVAILABLE", 503],
  ] as const)("maps %s consistently", async (code, status) => {
    const context = createRequestContext();
    const response = errorResponse(new ApplicationError(code), context);
    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ error: { code, fields: [] }, meta: context });
  });

  it("never returns unknown exception messages, stacks, credentials or forged codes", async () => {
    for (const error of [new Error("mongodb://user:secret@host"), { code: "FORBIDDEN", message: "private" }, null]) {
      const response = errorResponse(error, createRequestContext());
      expect(response.status).toBe(500);
      const body = await response.text();
      expect(body).toContain("INTERNAL_ERROR");
      expect(body).not.toMatch(/secret|private|mongodb|stack/);
    }
  });

  it("maps unavailable database infrastructure without exposing driver details", async () => {
    const response = errorResponse(new DatabaseConnectionError(), createRequestContext());
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: "SERVICE_UNAVAILABLE" } });
  });
});
