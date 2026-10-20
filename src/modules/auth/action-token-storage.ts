import { isDeepStrictEqual } from "node:util";
import type { Connection, mongo } from "mongoose";
import { ACTION_TOKEN_PURPOSES } from "./action-token-format.ts";
import { TOKEN_HASH_PATTERN } from "./session-format.ts";

export const actionTokenValidator: mongo.Document = { $and: [{ $jsonSchema: {
  bsonType: "object", additionalProperties: false,
  required: ["_id", "tokenHash", "purpose", "userId", "sessionVersion", "expiresAt", "createdAt", "updatedAt"],
  properties: {
    _id: { bsonType: "objectId" }, tokenHash: { bsonType: "string", pattern: TOKEN_HASH_PATTERN },
    purpose: { enum: [...ACTION_TOKEN_PURPOSES] }, userId: { bsonType: "objectId" },
    sessionVersion: { bsonType: ["int", "long", "double"], minimum: 0, maximum: Number.MAX_SAFE_INTEGER, multipleOf: 1 },
    expiresAt: { bsonType: "date" }, consumedAt: { bsonType: "date" },
    createdAt: { bsonType: "date" }, updatedAt: { bsonType: "date" },
  },
} }, { $expr: { $gt: ["$expiresAt", "$createdAt"] } }] };

export const actionTokenIndexes: readonly mongo.IndexDescription[] = [
  { key: { tokenHash: 1 }, name: "auth_action_token_unique", unique: true },
  { key: { userId: 1, purpose: 1 }, name: "auth_action_token_user_purpose" },
  { key: { expiresAt: 1 }, name: "auth_action_token_expiry", expireAfterSeconds: 0 },
];

export async function verifyActionTokens(connection: Connection): Promise<void> {
  if (!connection.db) throw new Error("An open database is required.");
  const info = await connection.db.listCollections({ name: "authActionTokens" }, { timeoutMS: 5000 }).next();
  if (!info || !("options" in info) || !isDeepStrictEqual(info.options.validator, actionTokenValidator)
    || info.options.validationLevel !== "strict" || info.options.validationAction !== "error") throw new Error("Authentication token validator verification failed.");
  const actual = await connection.db.collection("authActionTokens").listIndexes({ timeoutMS: 5000 }).toArray();
  for (const expected of actionTokenIndexes) {
    const index = actual.find((item) => item.name === expected.name);
    if (!index || !isDeepStrictEqual(index.key, expected.key) || Boolean(index.unique) !== Boolean(expected.unique)
      || index.expireAfterSeconds !== expected.expireAfterSeconds || index.sparse === true || index.hidden === true
      || index.partialFilterExpression !== undefined || index.collation !== undefined) throw new Error("Authentication token index verification failed.");
  }
}
