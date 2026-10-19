import "server-only";
import { Schema, type Connection, type InferSchemaType, type Model } from "mongoose";

const schema = new Schema({
  scopeKind: { type: String, enum: ["tenant", "global"], required: true, immutable: true },
  scopeKey: { type: String, required: true, immutable: true },
  organizationId: { type: Schema.Types.ObjectId, immutable: true },
  actorId: { type: Schema.Types.ObjectId, required: true, immutable: true },
  operation: { type: String, required: true, immutable: true },
  keyHash: { type: String, required: true, immutable: true },
  requestHash: { type: String, required: true, immutable: true },
  status: { type: String, enum: ["pending", "completed"], required: true },
  responseStatus: Number,
  responseJson: String,
  expiresAt: { type: Date, required: true },
}, { strict: "throw", timestamps: true, versionKey: false, autoCreate: false, autoIndex: false });

export type IdempotencyRecord = InferSchemaType<typeof schema>;
export function getIdempotencyModel(connection: Connection): Model<IdempotencyRecord> {
  return (connection.models.IdempotencyRecord as Model<IdempotencyRecord> | undefined)
    ?? connection.model<IdempotencyRecord>("IdempotencyRecord", schema, "idempotencyRecords");
}
