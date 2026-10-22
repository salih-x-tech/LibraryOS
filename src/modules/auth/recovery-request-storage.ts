import { isDeepStrictEqual } from "node:util";
import type { Connection, mongo } from "mongoose";
import { ACTION_TOKEN_PURPOSES } from "./action-token-format.ts";

export const recoveryRequestValidator: mongo.Document = { $jsonSchema: {
  bsonType: "object", additionalProperties: false,
  required: ["_id", "purpose", "requestId", "ciphertext", "nonce", "tag", "status", "createdAt"],
  properties: { _id: { bsonType: "objectId" }, purpose: { enum: [...ACTION_TOKEN_PURPOSES] },
    requestId: { bsonType: "string", pattern: "^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$" },
    ciphertext: { bsonType: "string", pattern: "^[a-f0-9]{2048}$" }, nonce: { bsonType: "string", pattern: "^[a-f0-9]{24}$" },
    tag: { bsonType: "string", pattern: "^[a-f0-9]{32}$" }, status: { enum: ["pending"] }, createdAt: { bsonType: "date" } },
} };
export const recoveryRequestIndexes: readonly mongo.IndexDescription[] = [
  { key: { requestId: 1 }, name: "recovery_request_unique", unique: true },
  { key: { status: 1, createdAt: 1, _id: 1 }, name: "recovery_request_pending" },
];
export async function verifyRecoveryRequests(connection: Connection): Promise<void> {
  if (!connection.db) throw new Error("An open database is required.");
  const info = await connection.db.listCollections({ name: "authRecoveryRequests" }, { timeoutMS: 5000 }).next();
  if (!info || !("options" in info) || !isDeepStrictEqual(info.options.validator, recoveryRequestValidator)
    || info.options.validationLevel !== "strict" || info.options.validationAction !== "error") throw new Error("Recovery request validator verification failed.");
  const actual = await connection.db.collection("authRecoveryRequests").listIndexes({ timeoutMS: 5000 }).toArray();
  // Retention/worker lifecycle remain separate decisions, never infer a TTL.
  if (actual.some((index) => index.expireAfterSeconds !== undefined)) throw new Error("Recovery request retention requires review.");
  for (const expected of recoveryRequestIndexes) {
    const found = actual.find((index) => index.name === expected.name);
    if (!found || !isDeepStrictEqual(found.key, expected.key) || Boolean(found.unique) !== Boolean(expected.unique)
      || found.partialFilterExpression !== undefined || found.sparse === true || found.hidden === true || found.collation !== undefined) throw new Error("Recovery request index verification failed.");
  }
}
