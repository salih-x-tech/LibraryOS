import "server-only";
import { Schema, type Connection, type InferSchemaType, type Model } from "mongoose";
import { normalizeEmail } from "./validation";
import { isSupportedPasswordHash } from "./password-format";

const counter = { type: Number, required: true, min: 0, validate: Number.isSafeInteger };
const schema = new Schema({
  normalizedEmail: {
    type: String, required: true, maxlength: 254,
    validate: (value: string) => {
      try { return normalizeEmail(value) === value; } catch { return false; }
    },
  },
  // Only hashing services may supply this field. Public queries omit it.
  passwordHash: { type: String, required: true, select: false, validate: isSupportedPasswordHash },
  verifiedAt: Date,
  // No activation/status default while D02 remains unapproved. Future services
  // must explicitly allow approved states; a stored status is not access proof.
  status: { type: String, required: true, match: /^[a-z][a-z0-9_]{0,39}$/ },
  sessionVersion: counter,
  authorizationVersion: counter,
  operationFence: counter,
}, { strict: "throw", timestamps: true, versionKey: false, autoCreate: false, autoIndex: false });

export type UserRecord = InferSchemaType<typeof schema>;
export function getUserModel(connection: Connection): Model<UserRecord> {
  return (connection.models.User as Model<UserRecord> | undefined) ?? connection.model<UserRecord>("User", schema, "users");
}
