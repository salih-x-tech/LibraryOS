import { describe, expect, it } from "vitest";
import { canonicalJson, executeIdempotent, type IdempotencyInput } from "@/server/idempotency/service";
import type { Connection } from "mongoose";
import type { JsonValue } from "@/server/http/responses";

describe("canonical idempotency DTO hashing input", () => {
  it("requires bounded keys and explicit retention before opening persistence", async () => {
    const base: IdempotencyInput = {
      scope: { kind: "global" }, actorId: "0123456789abcdef01234567", operation: "test.probe",
      key: "test-key-123", request: {}, retentionMs: 60_000,
    };
    const work = async () => ({ status: 200 as const, data: null });
    for (const input of [
      { ...base, key: "short" }, { ...base, key: "unsafe\nkey" }, { ...base, key: "a".repeat(201) },
      { ...base, retentionMs: 0 }, { ...base, retentionMs: Infinity }, { ...base, retentionMs: -1 },
    ]) {
      await expect(executeIdempotent({} as Connection, input, async () => {}, work)).rejects.toThrow();
    }
  });
  it("normalizes object key ordering without changing arrays or values", () => {
    expect(canonicalJson({ b: 2, a: { y: true, x: null } })).toBe(canonicalJson({ a: { x: null, y: true }, b: 2 }));
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });
  it("rejects non-JSON, operator/prototype, oversized, cyclic and deeply nested input", () => {
    const cycle: { self?: JsonValue } = {};
    cycle.self = cycle;
    let deep: JsonValue = null;
    for (let i = 0; i < 22; i++) deep = { next: deep };
    for (const value of [undefined, NaN, new Date(), cycle, deep, { $set: true }, JSON.parse('{"__proto__":{}}'), "a".repeat(65_537)]) {
      expect(() => canonicalJson(value as JsonValue)).toThrow();
    }
  });
});
