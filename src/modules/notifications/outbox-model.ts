import "server-only";
import { Schema, type Connection, type InferSchemaType, type Model } from "mongoose";

const payloadSchema = new Schema({
  recipientUserId: Schema.Types.ObjectId,
  memberId: Schema.Types.ObjectId,
}, { _id: false, versionKey: false, strict: "throw" });

const schema = new Schema({
  organizationId: { type: Schema.Types.ObjectId, required: true, immutable: true },
  eventType: { type: String, required: true },
  resourceId: { type: Schema.Types.ObjectId, required: true },
  payload: { type: payloadSchema, required: true },
  status: { type: String, enum: ["pending", "processing", "delivered", "failed"], required: true },
  availableAt: { type: Date, required: true },
  leaseUntil: Date,
  leaseToken: String,
  attemptCount: { type: Number, required: true, min: 0 },
  eventKey: { type: String, required: true },
}, { strict: "throw", minimize: false, timestamps: true, versionKey: false, autoCreate: false, autoIndex: false });

export type OutboxRecord = InferSchemaType<typeof schema>;
export function getOutboxModel(connection: Connection): Model<OutboxRecord> {
  return (connection.models.OutboxEvent as Model<OutboxRecord> | undefined) ?? connection.model<OutboxRecord>("OutboxEvent", schema, "outboxEvents");
}
