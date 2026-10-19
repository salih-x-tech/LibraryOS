import { isDeepStrictEqual } from "node:util";
import type { Connection, mongo } from "mongoose";
import { TOKEN_HASH_PATTERN } from "../../src/modules/auth/session-format.ts";

export const sessionValidator: mongo.Document = { $jsonSchema: {
  bsonType: "object", additionalProperties: false,
  required: ["_id", "tokenHash", "userId", "expiresAt", "sessionVersion", "createdAt", "updatedAt"],
  properties: {
    _id: { bsonType: "objectId" }, tokenHash: { bsonType: "string", pattern: TOKEN_HASH_PATTERN },
    userId: { bsonType: "objectId" }, expiresAt: { bsonType: "date" }, revokedAt: { bsonType: "date" },
    sessionVersion: { bsonType: ["int", "long", "double"], minimum: 0, maximum: Number.MAX_SAFE_INTEGER, multipleOf: 1 },
    createdAt: { bsonType: "date" }, updatedAt: { bsonType: "date" },
  },
} };

const indexes: readonly mongo.IndexDescription[] = [
  { key: { tokenHash: 1 }, name: "session_token_unique", unique: true },
  { key: { userId: 1 }, name: "session_user" },
  { key: { expiresAt: 1 }, name: "session_expiry", expireAfterSeconds: 0 },
];

export async function deploySessions(connection: Connection): Promise<void> {
  if (!connection.db) throw new Error("An open database is required.");
  if (await connection.db.listCollections({ name: "sessions" }).hasNext()) {
    if (await connection.db.collection("sessions").countDocuments({ $nor: [sessionValidator] }, { limit: 1 })) {
      throw new Error("Existing session data requires migration.");
    }
    await connection.db.command({ collMod: "sessions", validator: sessionValidator, validationLevel: "strict", validationAction: "error" });
  } else {
    await connection.db.createCollection("sessions", { validator: sessionValidator, validationLevel: "strict", validationAction: "error" });
  }
  await connection.db.collection("sessions").createIndexes([...indexes]);
  const info = await connection.db.listCollections({ name: "sessions" }).next();
  if (!info || !("options" in info) || !isDeepStrictEqual(info.options.validator, sessionValidator)
    || info.options.validationLevel !== "strict" || info.options.validationAction !== "error") throw new Error("Session validator verification failed.");
  const actual = await connection.db.collection("sessions").listIndexes().toArray();
  for (const expected of indexes) {
    const index = actual.find((item) => item.name === expected.name);
    if (!index || !isDeepStrictEqual(index.key, expected.key) || Boolean(index.unique) !== Boolean(expected.unique)
      || index.expireAfterSeconds !== expected.expireAfterSeconds || index.sparse === true || index.hidden === true
      || index.partialFilterExpression !== undefined || index.collation !== undefined) throw new Error("Session index verification failed.");
  }
}
