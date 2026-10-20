import "server-only";
import { Schema, type Connection, type InferSchemaType, type Model } from "mongoose";
import { ACTION_TOKEN_PURPOSES } from "./action-token-format";
import { TOKEN_HASH_PATTERN } from "./session-format";

const schema = new Schema({
  tokenHash: { type: String, required: true, immutable: true, select: false, match: new RegExp(TOKEN_HASH_PATTERN) },
  purpose: { type: String, required: true, immutable: true, enum: ACTION_TOKEN_PURPOSES },
  userId: { type: Schema.Types.ObjectId, required: true, immutable: true },
  sessionVersion: { type: Number, required: true, immutable: true, min: 0, validate: Number.isSafeInteger },
  expiresAt: { type: Date, required: true, immutable: true },
  consumedAt: Date,
}, { strict: "throw", timestamps: true, versionKey: false, autoCreate: false, autoIndex: false });

export type ActionTokenRecord = InferSchemaType<typeof schema>;
export function getActionTokenModel(connection: Connection): Model<ActionTokenRecord> {
  return (connection.models.AuthActionToken as Model<ActionTokenRecord> | undefined)
    ?? connection.model<ActionTokenRecord>("AuthActionToken", schema, "authActionTokens");
}
