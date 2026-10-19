import "server-only";
import { Types, type mongo } from "mongoose";
import { ApplicationError } from "@/server/http/errors";

// Selection is not authorization. Services must first resolve active membership
// and permissions, and take the documented transactional guards on mutations.
export type TenantScope = Readonly<{ organizationId: string }>;

function objectId(value: string): Types.ObjectId {
  if (typeof value !== "string" || !/^[a-f0-9]{24}$/.test(value)) {
    throw new ApplicationError("BAD_REQUEST");
  }
  return new Types.ObjectId(value);
}

export function createTenantScope(organizationId: string): TenantScope {
  objectId(organizationId);
  return Object.freeze({ organizationId });
}

// Internal service-built predicates only. Never pass request query objects here.
// $and keeps the mandatory tenant predicate independent of all other conditions.
export function tenantFilter<T extends mongo.Document>(scope: TenantScope, predicate: mongo.Filter<T>): mongo.Filter<T> {
  if (!scope) throw new ApplicationError("BAD_REQUEST");
  const organizationId = objectId(scope.organizationId);
  return { $and: [{ organizationId }, predicate] } as mongo.Filter<T>;
}

export function requireTenantReference(scope: TenantScope, organizationId: Types.ObjectId): void {
  if (!scope) throw new ApplicationError("BAD_REQUEST");
  const selected = objectId(scope.organizationId);
  if (!(organizationId instanceof Types.ObjectId) || !selected.equals(organizationId)) {
    throw new ApplicationError("NOT_FOUND");
  }
}
