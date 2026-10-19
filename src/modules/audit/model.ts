import "server-only";
import { Schema, type Connection, type InferSchemaType, type Model } from "mongoose";

const schema = new Schema({
  scopeKind: { type: String, enum: ["tenant", "global"], required: true, immutable: true },
  scopeKey: { type: String, required: true, immutable: true },
  organizationId: { type: Schema.Types.ObjectId, immutable: true },
  actorId: Schema.Types.ObjectId,
  systemIdentity: String,
  action: { type: String, required: true },
  resourceType: { type: String, required: true },
  resourceId: { type: Schema.Types.ObjectId, required: true },
  branchIds: { type: [Schema.Types.ObjectId], required: true },
  timestamp: { type: Date, required: true },
  requestId: { type: String, required: true },
  changedFields: { type: [String], required: true },
}, { strict: "throw", timestamps: true, versionKey: false, autoCreate: false, autoIndex: false });

export type AuditRecord = InferSchemaType<typeof schema>;
export function getAuditModel(connection: Connection): Model<AuditRecord> {
  return (connection.models.AuditEvent as Model<AuditRecord> | undefined) ?? connection.model<AuditRecord>("AuditEvent", schema, "auditEvents");
}
