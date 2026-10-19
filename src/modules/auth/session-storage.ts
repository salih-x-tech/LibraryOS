import { isDeepStrictEqual } from "node:util";
import type { Connection, mongo } from "mongoose";
import { TOKEN_HASH_PATTERN } from "./session-format.ts";
import { SESSION_LIFETIME_MS } from "./session-policy.ts";

export const sessionValidator: mongo.Document = { $and: [{ $jsonSchema: {
  bsonType: "object", additionalProperties: false,
  required: ["_id", "tokenHash", "userId", "familyId", "startedAt", "lastSeenAt", "expiresAt", "sessionVersion", "createdAt", "updatedAt"],
  properties: {
    _id: { bsonType: "objectId" }, tokenHash: { bsonType: "string", pattern: TOKEN_HASH_PATTERN },
    userId: { bsonType: "objectId" }, expiresAt: { bsonType: "date" }, revokedAt: { bsonType: "date" },
    familyId: { bsonType: "objectId" }, startedAt: { bsonType: "date" }, lastSeenAt: { bsonType: "date" },
    sessionVersion: { bsonType: ["int", "long", "double"], minimum: 0, maximum: Number.MAX_SAFE_INTEGER, multipleOf: 1 },
    createdAt: { bsonType: "date" }, updatedAt: { bsonType: "date" },
  },
} }, { $expr: { $lte: ["$expiresAt", { $add: ["$startedAt", SESSION_LIFETIME_MS] }] } }] };

export const sessionIndexes: readonly mongo.IndexDescription[] = [
  { key: { tokenHash: 1 }, name: "session_token_unique", unique: true },
  { key: { userId: 1 }, name: "session_user" },
  { key: { userId: 1, familyId: 1 }, name: "session_user_family" },
  { key: { expiresAt: 1 }, name: "session_expiry", expireAfterSeconds: 0 },
];

export async function verifySessions(connection: Connection): Promise<void> {
  if (!connection.db) throw new Error("An open database is required.");
  const info = await connection.db.listCollections({ name: "sessions" }, { timeoutMS: 5000 }).next();
  if (!info || !("options" in info) || !isDeepStrictEqual(info.options.validator, sessionValidator)
    || info.options.validationLevel !== "strict" || info.options.validationAction !== "error") throw new Error("Session validator verification failed.");
  const actual = await connection.db.collection("sessions").listIndexes({ timeoutMS: 5000 }).toArray();
  for (const expected of sessionIndexes) {
    const index = actual.find((item) => item.name === expected.name);
    if (!index || !isDeepStrictEqual(index.key, expected.key) || Boolean(index.unique) !== Boolean(expected.unique)
      || index.expireAfterSeconds !== expected.expireAfterSeconds || index.sparse === true || index.hidden === true
      || index.partialFilterExpression !== undefined || index.collation !== undefined) throw new Error("Session index verification failed.");
  }
}
