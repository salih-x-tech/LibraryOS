import { describe, expect, it } from "vitest";
import { Types } from "mongoose";
import { createTenantScope, requireTenantReference, tenantFilter, type TenantScope } from "@/server/db/scope";

const tenant = "0123456789abcdef01234567";
describe("tenant-required query primitives", () => {
  it("validates and freezes tenant selection", () => {
    expect(Object.isFrozen(createTenantScope(tenant))).toBe(true);
    for (const value of ["", "global", "__proto__", "{$ne:null}", "a".repeat(23)]) {
      expect(() => createTenantScope(value)).toThrow("The request is malformed.");
    }
  });
  it("rejects absent and invalid runtime scope", () => {
    expect(() => tenantFilter(undefined as unknown as TenantScope, {})).toThrow();
    expect(() => tenantFilter({ organizationId: "" }, {})).toThrow();
  });
  it("preserves the tenant predicate even with conflicting service conditions", () => {
    const predicate = { organizationId: new Types.ObjectId(), $or: [{ status: "active" }, {}] };
    expect(tenantFilter(createTenantScope(tenant), predicate)).toEqual({
      $and: [{ organizationId: new Types.ObjectId(tenant) }, predicate],
    });
  });
  it("accepts same-tenant references and hides foreign references", () => {
    const scope = createTenantScope(tenant);
    expect(() => requireTenantReference(scope, new Types.ObjectId(tenant))).not.toThrow();
    expect(() => requireTenantReference(scope, new Types.ObjectId())).toThrow("Resource not found.");
  });
});
