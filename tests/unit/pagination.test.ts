import { describe, expect, it } from "vitest";
import { ApplicationError } from "@/server/http/errors";
import { createCursorCodec, parsePageSize, readPaginationParams, slicePage, type CursorScope } from "@/server/http/pagination";
import { createRequestContext, listResponse } from "@/server/http/responses";

const scope: CursorScope = { organizationId: "org-a", resource: "copies", direction: "asc", filters: { branchId: "branch-a", status: "available" } };
const position = { createdAt: "2026-10-19T10:00:00.000Z", id: "0123456789abcdef01234567" };
const codec = createCursorCodec(Buffer.alloc(32, 1));

describe("bounded pagination", () => {
  it("defaults to 25 and accepts bounds", () => {
    expect(parsePageSize(null)).toBe(25);
    expect(parsePageSize("1")).toBe(1);
    expect(parsePageSize("100")).toBe(100);
  });
  it.each(["", "0", "101", "1000", "-1", "1.5", "1e2", " 25", "025", "$gt"]) ("rejects invalid limit %s", (value) => {
    expect(() => parsePageSize(value)).toThrow(ApplicationError);
  });
  it("rejects duplicate and oversized query values", () => {
    for (const query of ["limit=1&limit=2", "cursor=a&cursor=b", "cursor=", `cursor=${"a".repeat(2049)}`]) {
      expect(() => readPaginationParams(new URLSearchParams(query))).toThrow(ApplicationError);
    }
    expect(readPaginationParams(new URLSearchParams())).toEqual({ limit: 25, cursor: null });
  });
  it("uses the lookahead row without returning it", () => {
    expect(slicePage([1, 2, 3], 2)).toEqual({ data: [1, 2], hasMore: true });
    expect(slicePage([1, 2], 2)).toEqual({ data: [1, 2], hasMore: false });
    expect(slicePage([], 2)).toEqual({ data: [], hasMore: false });
    expect(() => slicePage([1, 2, 3, 4], 2)).toThrow();
    expect(() => slicePage([], 101)).toThrow();
  });
  it("returns list metadata, including null at the end", async () => {
    const context = createRequestContext();
    const response = listResponse([{ id: "one" }], null, context);
    expect(await response.json()).toEqual({ data: [{ id: "one" }], meta: { ...context, nextCursor: null } });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});

describe("signed scoped cursors", () => {
  it("round trips across replicas with the same key and normalized filter order", () => {
    const cursor = codec.encode(position, scope);
    const replica = createCursorCodec(Buffer.alloc(32, 1));
    expect(replica.decode(cursor, { ...scope, filters: { status: "available", branchId: "branch-a" } })).toEqual(position);
  });
  it("rejects use in another tenant, resource, branch, filter or sort", () => {
    const cursor = codec.encode(position, scope);
    const otherScopes: CursorScope[] = [
      { ...scope, organizationId: "org-b" }, { ...scope, resource: "members" },
      { ...scope, direction: "desc" }, { ...scope, filters: { ...scope.filters, branchId: "branch-b" } },
      { ...scope, filters: { ...scope.filters, status: "lost" } },
    ];
    for (const other of otherScopes) expect(() => codec.decode(cursor, other)).toThrow(ApplicationError);
  });
  it("rejects tampering, another signing key and malformed input with a generic error", () => {
    const cursor = codec.encode(position, scope);
    for (const input of ["", "x.y", "a".repeat(2049), `${cursor}x`, `A${cursor.slice(1)}`, "__proto__"]) {
      expect(() => codec.decode(input, scope)).toThrow("The request is malformed.");
    }
    expect(() => createCursorCodec(Buffer.alloc(32, 2)).decode(cursor, scope)).toThrow(ApplicationError);
  });
  it("rejects invalid server positions and undersized keys", () => {
    expect(() => createCursorCodec(Buffer.alloc(31))).toThrow();
    for (const bad of [{ ...position, id: "$ne" }, { ...position, createdAt: "2026-02-30T10:00:00.000Z" }]) {
      expect(() => codec.encode(bad, scope)).toThrow();
    }
  });
});
