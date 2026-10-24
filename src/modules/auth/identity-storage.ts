import { isDeepStrictEqual } from "node:util";
import type { Connection, mongo } from "mongoose";
import { PASSWORD_HASH_PATTERN } from "./password-format.ts";

const counter = { bsonType: ["int", "long", "double"], minimum: 0, maximum: Number.MAX_SAFE_INTEGER, multipleOf: 1 };
export const userValidator: mongo.Document = { $and: [{ $jsonSchema: {
  bsonType: "object", additionalProperties: false,
  required: ["_id", "normalizedEmail", "passwordHash", "status", "sessionVersion", "authorizationVersion", "operationFence", "createdAt", "updatedAt"],
  properties: {
    _id: { bsonType: "objectId" },
    normalizedEmail: { bsonType: "string", maxLength: 254, pattern: "^[^\\s@\\x00-\\x1f\\x7f]+@[^\\s@\\x00-\\x1f\\x7f]+$" },
    passwordHash: { bsonType: "string", maxLength: 128, pattern: PASSWORD_HASH_PATTERN }, verifiedAt: { bsonType: "date" },
    displayName: { bsonType: "string", maxLength: 100 },
    status: { bsonType: "string", pattern: "^[a-z][a-z0-9_]{0,39}$" },
    sessionVersion: counter, authorizationVersion: counter, operationFence: counter,
    createdAt: { bsonType: "date" }, updatedAt: { bsonType: "date" },
  },
} }, { $expr: { $eq: ["$normalizedEmail", { $toLower: { $trim: { input: "$normalizedEmail" } } }] } }] };

export async function verifyUserIdentity(connection: Connection): Promise<void> {
  if (!connection.db) throw new Error("An open database is required.");
  const info = await connection.db.listCollections({ name: "users" }, { timeoutMS: 5000 }).next();
  const index = (await connection.db.collection("users").listIndexes({ timeoutMS: 5000 }).toArray()).find((entry) => entry.name === "user_email_unique");
  if (!info || !("options" in info) || !isDeepStrictEqual(info.options.validator, userValidator)
    || info.options.validationAction !== "error" || info.options.validationLevel !== "strict"
    || !index || !isDeepStrictEqual(index.key, { normalizedEmail: 1 }) || index.unique !== true
    || index.sparse === true || index.partialFilterExpression !== undefined || index.collation !== undefined || index.hidden === true) {
    throw new Error("Identity deployment verification failed.");
  }
}
