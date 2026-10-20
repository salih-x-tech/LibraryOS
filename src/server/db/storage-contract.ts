import { isDeepStrictEqual } from "node:util";
import type { Connection, mongo } from "mongoose";
import { validators } from "./validators.ts";

export const indexes: Readonly<Record<string, readonly mongo.IndexDescription[]>> = {
  auditEvents: [
    { key: { organizationId: 1, timestamp: -1, _id: 1 }, name: "audit_tenant_time" },
    { key: { organizationId: 1, resourceType: 1, resourceId: 1, timestamp: -1 }, name: "audit_tenant_resource" },
  ],
  outboxEvents: [
    { key: { organizationId: 1, eventKey: 1 }, unique: true, name: "outbox_tenant_event_unique" },
    { key: { status: 1, availableAt: 1, leaseUntil: 1 }, name: "outbox_schedule" },
  ],
  idempotencyRecords: [
    { key: { scopeKey: 1, actorId: 1, operation: 1, keyHash: 1 }, unique: true, name: "idempotency_scope_unique" },
    { key: { expiresAt: 1 }, expireAfterSeconds: 0, name: "idempotency_expiry" },
  ],
};

export async function verifyInfrastructure(connection: Connection): Promise<void> {
  if (!connection.db) throw new Error("An open database is required.");
  for (const [name, validator] of Object.entries(validators)) {
    const info = await connection.db.listCollections({ name }, { timeoutMS: 5000 }).next();
    if (!info || !("options" in info) || !isDeepStrictEqual(info.options?.validator, validator)
      || info.options?.validationLevel !== "strict" || info.options?.validationAction !== "error") {
      throw new Error("Infrastructure collection validation does not match the deployment specification.");
    }
    const actual = await connection.db.collection(name).listIndexes({ timeoutMS: 5000 }).toArray();
    if (name !== "idempotencyRecords" && actual.some((index) => index.expireAfterSeconds !== undefined)) {
      throw new Error("Retention indexes on audit/outbox collections require an approved migration.");
    }
    for (const expected of indexes[name] ?? []) {
      const found = actual.find((index) => index.name === expected.name);
      if (!found || !isDeepStrictEqual(found.key, expected.key) || Boolean(found.unique) !== Boolean(expected.unique)
        || found.expireAfterSeconds !== expected.expireAfterSeconds || found.partialFilterExpression !== undefined
        || found.sparse === true || found.hidden === true || found.collation !== undefined) {
        throw new Error("Infrastructure index does not match the deployment specification.");
      }
    }
  }
}


