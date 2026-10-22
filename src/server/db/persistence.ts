import "server-only";
import { Types } from "mongoose";
import type { TransactionContext } from "./transaction";
import { createTenantScope } from "./scope";

export type PersistenceScope = Readonly<{ kind: "tenant"; organizationId: string }> | Readonly<{ kind: "global" }>;

export function persistenceScope(scope: PersistenceScope) {
  if (scope.kind === "global") return { scopeKind: "global" as const, scopeKey: "global" };
  const validated = createTenantScope(scope.organizationId);
  return { scopeKind: "tenant" as const, scopeKey: `tenant:${validated.organizationId}`, organizationId: new Types.ObjectId(validated.organizationId) };
}

export function requireTransaction(context: TransactionContext): void {
  if (!context.session.inTransaction()) throw new Error("Persistence requires an active transaction.");
}

export function identifier(value: string): Types.ObjectId {
  if (!/^[a-f0-9]{24}$/.test(value)) throw new Error("Invalid persistence identifier.");
  return new Types.ObjectId(value);
}

export function label(value: string): string {
  if (!/^[a-z][a-zA-Z0-9_.-]{0,79}$/.test(value)) throw new Error("Invalid persistence label.");
  return value;
}

export function requestId(value: string): `${string}-${string}-${string}-${string}-${string}` {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value)) throw new Error("Invalid persistence request ID.");
  return value as `${string}-${string}-${string}-${string}-${string}`;
}
