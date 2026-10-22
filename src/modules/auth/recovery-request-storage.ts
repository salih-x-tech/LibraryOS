import { isDeepStrictEqual } from "node:util";
import type { Connection, mongo } from "mongoose";
import { ACTION_TOKEN_PURPOSES } from "./action-token-format.ts";
import { RECOVERY_REQUEST_LEASE_MS, RECOVERY_REQUEST_TERMINAL_MS, RECOVERY_TERMINAL_STATES } from "./recovery-worker-policy.ts";

const payload = { ciphertext: { $exists: true }, nonce: { $exists: true }, tag: { $exists: true } };
const noPayload = { ciphertext: { $exists: false }, nonce: { $exists: false }, tag: { $exists: false } };
export const recoveryRequestValidator: mongo.Document = { $and: [{ $jsonSchema: {
  bsonType: "object", additionalProperties: false,
  required: ["_id", "purpose", "requestId", "status", "createdAt"],
  properties: { _id: { bsonType: "objectId" }, purpose: { enum: [...ACTION_TOKEN_PURPOSES] },
    requestId: { bsonType: "string", pattern: "^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$" },
    ciphertext: { bsonType: "string", pattern: "^[a-f0-9]{2048}$" }, nonce: { bsonType: "string", pattern: "^[a-f0-9]{24}$" },
    tag: { bsonType: "string", pattern: "^[a-f0-9]{32}$" }, status: { enum: ["pending", "processing", ...RECOVERY_TERMINAL_STATES] }, createdAt: { bsonType: "date" },
    claimedAt: { bsonType: "date" }, leaseUntil: { bsonType: "date" }, leaseHash: { bsonType: "string", pattern: "^[a-f0-9]{64}$" },
    leaseFence: { bsonType: ["int", "long", "double"], minimum: 0, maximum: Number.MAX_SAFE_INTEGER, multipleOf: 1 },
    finishedAt: { bsonType: "date" }, purgeAfter: { bsonType: "date" } },
} }, { $or: [
  { status: "pending", ...payload, claimedAt: { $exists: false }, leaseUntil: { $exists: false }, leaseHash: { $exists: false }, leaseFence: { $exists: false }, finishedAt: { $exists: false }, purgeAfter: { $exists: false } },
  { status: "processing", ...payload, claimedAt: { $exists: true }, leaseUntil: { $exists: true }, leaseHash: { $exists: true }, leaseFence: { $exists: true }, finishedAt: { $exists: false }, purgeAfter: { $exists: false },
    $expr: { $eq: ["$leaseUntil", { $add: ["$claimedAt", RECOVERY_REQUEST_LEASE_MS] }] } },
  { status: { $in: [...RECOVERY_TERMINAL_STATES] }, ...noPayload, leaseUntil: { $exists: false }, leaseHash: { $exists: false }, leaseFence: { $exists: false }, finishedAt: { $exists: true }, purgeAfter: { $exists: true },
    $expr: { $eq: ["$purgeAfter", { $add: ["$finishedAt", RECOVERY_REQUEST_TERMINAL_MS] }] } },
] }] };
export const recoveryRequestIndexes: readonly mongo.IndexDescription[] = [
  { key: { requestId: 1 }, name: "recovery_request_unique", unique: true },
  { key: { status: 1, createdAt: 1, _id: 1 }, name: "recovery_request_pending" },
  { key: { status: 1, leaseUntil: 1 }, name: "recovery_request_lease" },
  { key: { status: 1, purgeAfter: 1, _id: 1 }, name: "recovery_request_retention" },
];
export async function verifyRecoveryRequests(connection: Connection): Promise<void> {
  if (!connection.db) throw new Error("An open database is required.");
  const info = await connection.db.listCollections({ name: "authRecoveryRequests" }, { timeoutMS: 5000 }).next();
  if (!info || !("options" in info) || !isDeepStrictEqual(info.options.validator, recoveryRequestValidator)
    || info.options.validationLevel !== "strict" || info.options.validationAction !== "error") throw new Error("Recovery request validator verification failed.");
  const actual = await connection.db.collection("authRecoveryRequests").listIndexes({ timeoutMS: 5000 }).toArray();
  // Approved cleanup uses audited transitions/deletion, never TTL bypasses.
  if (actual.some((index) => index.expireAfterSeconds !== undefined)) throw new Error("Recovery request retention requires review.");
  for (const expected of recoveryRequestIndexes) {
    const found = actual.find((index) => index.name === expected.name);
    if (!found || !isDeepStrictEqual(found.key, expected.key) || Boolean(found.unique) !== Boolean(expected.unique)
      || found.partialFilterExpression !== undefined || found.sparse === true || found.hidden === true || found.collation !== undefined) throw new Error("Recovery request index verification failed.");
  }
}
