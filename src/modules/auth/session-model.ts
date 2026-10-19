import "server-only";
import { Schema, type Connection, type InferSchemaType, type Model } from "mongoose";
import { TOKEN_HASH_PATTERN } from "./session-format";

const schema = new Schema({
  tokenHash: { type: String, required: true, immutable: true, select: false, match: new RegExp(TOKEN_HASH_PATTERN) },
  userId: { type: Schema.Types.ObjectId, required: true, immutable: true },
  expiresAt: { type: Date, required: true },
  revokedAt: Date,
  sessionVersion: { type: Number, required: true, min: 0, validate: Number.isSafeInteger },
}, { strict: "throw", timestamps: true, versionKey: false, autoCreate: false, autoIndex: false });

export type SessionRecord = InferSchemaType<typeof schema>;
export function getSessionModel(connection: Connection): Model<SessionRecord> {
  return (connection.models.Session as Model<SessionRecord> | undefined) ?? connection.model<SessionRecord>("Session", schema, "sessions");
}
