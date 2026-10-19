import { describe, expect, it } from "vitest";
import { createLogger, type LogDetails, type LogEvent } from "@/server/logging";
import { createRequestContext } from "@/server/http/responses";

describe("safe structured logging", () => {
  it("projects only allowlisted metadata and drops secrets even in nested or cyclic input", () => {
    const lines: string[] = [];
    const details = {
      ...createRequestContext(), status: 500, durationMs: 12, errorCode: "INTERNAL_ERROR" as const,
      password: "secret", uri: "mongodb://secret", headers: { authorization: "Bearer secret" },
      error: new Error("private"), body: { email: "private@example.com" }, cycle: {} as unknown,
    };
    details.cycle = details;
    createLogger((line) => lines.push(line)).write("request.failed", details);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toEqual({
      timestamp: expect.any(String), level: "error", event: "request.failed",
      requestId: details.requestId, status: 500, durationMs: 12, errorCode: "INTERNAL_ERROR",
    });
    expect(lines[0]).not.toMatch(/secret|private|mongodb|authorization|password|stack/);
  });

  it("rejects injection into fields that are normally retained", () => {
    const lines: string[] = [];
    const logger = createLogger((line) => lines.push(line));
    const context = createRequestContext();
    for (const details of [
      { requestId: "secret\nforged" }, { ...context, status: 999 },
      { ...context, durationMs: Infinity }, { ...context, durationMs: -1 },
      { ...context, errorCode: "mongodb://secret" }, { ...context, errorCode: "__proto__" },
    ]) {
      expect(() => logger.write("request.failed", details as LogDetails)).toThrow();
    }
    expect(() => logger.write("private\nforged" as LogEvent, context)).toThrow();
    expect(lines).toEqual([]);
  });

  it("writes completion metadata and contains sink failures", () => {
    const lines: string[] = [];
    createLogger((line) => lines.push(line)).write("request.completed", createRequestContext());
    expect(JSON.parse(lines[0]!)).toMatchObject({ level: "info", event: "request.completed" });
    expect(() => createLogger(() => { throw new Error("private sink failure"); })
      .write("database.unavailable", createRequestContext())).not.toThrow();
  });
});
