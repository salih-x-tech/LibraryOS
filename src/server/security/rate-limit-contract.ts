import { isDeepStrictEqual } from "node:util";
import type { Connection, mongo } from "mongoose";

export const RATE_LIMIT_POLICIES = Object.freeze({
  "login.ip": Object.freeze({ limit: 30, windowMs: 15 * 60_000 }),
  "login.account": Object.freeze({ limit: 5, windowMs: 15 * 60_000 }),
  "registration.ip": Object.freeze({ limit: 5, windowMs: 60 * 60_000 }),
  "registration.account": Object.freeze({ limit: 3, windowMs: 60 * 60_000 }),
  "recovery.ip": Object.freeze({ limit: 5, windowMs: 60 * 60_000 }),
  "recovery.account": Object.freeze({ limit: 3, windowMs: 60 * 60_000 }),
  "verification.ip": Object.freeze({ limit: 30, windowMs: 15 * 60_000 }),
  "reset.ip": Object.freeze({ limit: 30, windowMs: 15 * 60_000 }),
});
export type RateLimitKind = keyof typeof RATE_LIMIT_POLICIES;
export const BUCKET_COLLECTION = "rateLimitBuckets";
export const ATTEMPT_COLLECTION = "loginRateLimitAttempts";
const digest = { bsonType: "string", pattern: "^[a-f0-9]{64}$" };
const date = { bsonType: "date" };
const integer = { bsonType: ["int", "long", "double"], minimum: 0, maximum: Number.MAX_SAFE_INTEGER, multipleOf: 1 };

export const rateLimitValidators: Readonly<Record<string, mongo.Document>> = {
  [BUCKET_COLLECTION]: { $jsonSchema: {
    bsonType: "object", additionalProperties: false,
    required: ["_id", "kind", "windowId", "count", "admitted", "retryAfterSeconds", "expiresAt", "createdAt", "updatedAt"],
    properties: { _id: digest, kind: { enum: Object.keys(RATE_LIMIT_POLICIES) }, windowId: { bsonType: "objectId" },
      count: integer, admitted: { bsonType: "bool" }, retryAfterSeconds: integer, expiresAt: date, createdAt: date, updatedAt: date },
  } },
  [ATTEMPT_COLLECTION]: { $jsonSchema: {
    bsonType: "object", additionalProperties: false,
    required: ["_id", "bucketKey", "windowId", "status", "expiresAt", "createdAt", "updatedAt"],
    properties: { _id: { bsonType: "objectId" }, bucketKey: digest, windowId: { bsonType: "objectId" },
      status: { enum: ["pending", "success", "failure"] }, expiresAt: date, createdAt: date, updatedAt: date },
  } },
};

export async function verifyRateLimitStorage(connection: Connection): Promise<void> {
  if (!connection.db) throw new Error("An open database is required.");
  for (const [name, validator] of Object.entries(rateLimitValidators)) {
    const info = await connection.db.listCollections({ name }, { timeoutMS: 5_000 }).next();
    if (!info || !("options" in info) || !isDeepStrictEqual(info.options.validator, validator)
      || info.options.validationLevel !== "strict" || info.options.validationAction !== "error") throw new Error("Limiter validator verification failed.");
    const actual = await connection.db.collection(name).listIndexes({ timeoutMS: 5_000 }).toArray();
    const expiry = actual.find((index) => index.name === "rate_limit_expiry");
    if (!expiry || !isDeepStrictEqual(expiry.key, { expiresAt: 1 }) || expiry.expireAfterSeconds !== 0
      || expiry.sparse === true || expiry.hidden === true || expiry.partialFilterExpression !== undefined) throw new Error("Limiter expiry index verification failed.");
  }
}
