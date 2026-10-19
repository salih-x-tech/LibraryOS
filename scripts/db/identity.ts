import { isDeepStrictEqual } from "node:util";
import type { Connection, mongo } from "mongoose";
import { PASSWORD_HASH_PATTERN } from "../../src/modules/auth/password-format.ts";

const counter = { bsonType: ["int", "long", "double"], minimum: 0, maximum: Number.MAX_SAFE_INTEGER, multipleOf: 1 };
export const userValidator: mongo.Document = { $and: [{ $jsonSchema: {
  bsonType: "object", additionalProperties: false,
  required: ["_id", "normalizedEmail", "passwordHash", "status", "sessionVersion", "authorizationVersion", "operationFence", "createdAt", "updatedAt"],
  properties: {
    _id: { bsonType: "objectId" },
    normalizedEmail: { bsonType: "string", maxLength: 254, pattern: "^[^\\s@\\x00-\\x1f\\x7f]+@[^\\s@\\x00-\\x1f\\x7f]+$" },
    passwordHash: { bsonType: "string", maxLength: 128, pattern: PASSWORD_HASH_PATTERN }, verifiedAt: { bsonType: "date" },
    status: { bsonType: "string", pattern: "^[a-z][a-z0-9_]{0,39}$" },
    sessionVersion: counter, authorizationVersion: counter, operationFence: counter,
    createdAt: { bsonType: "date" }, updatedAt: { bsonType: "date" },
  },
} }, { $expr: { $eq: ["$normalizedEmail", { $toLower: { $trim: { input: "$normalizedEmail" } } }] } }] };

// Explicit, separate identity provisioning. The Phase 2 CLI remains unchanged.
export async function deployUserIdentity(connection: Connection): Promise<void> {
  if (!connection.db) throw new Error("An open database is required.");
  if (await connection.db.listCollections({ name: "users" }).hasNext()) {
    if (await connection.db.collection("users").countDocuments({ $nor: [userValidator] }, { limit: 1 })) {
      throw new Error("Existing identity data requires migration.");
    }
    await connection.db.command({ collMod: "users", validator: userValidator, validationLevel: "strict", validationAction: "error" });
  } else {
    await connection.db.createCollection("users", { validator: userValidator, validationLevel: "strict", validationAction: "error" });
  }
  await connection.db.collection("users").createIndex({ normalizedEmail: 1 }, { name: "user_email_unique", unique: true });
  const info = await connection.db.listCollections({ name: "users" }).next();
  const index = (await connection.db.collection("users").listIndexes().toArray()).find((entry) => entry.name === "user_email_unique");
  if (!info || !("options" in info) || !isDeepStrictEqual(info.options.validator, userValidator)
    || info.options.validationAction !== "error" || info.options.validationLevel !== "strict"
    || !index || !isDeepStrictEqual(index.key, { normalizedEmail: 1 }) || index.unique !== true
    || index.sparse === true || index.partialFilterExpression !== undefined || index.collation !== undefined || index.hidden === true) {
    throw new Error("Identity deployment verification failed.");
  }
}
