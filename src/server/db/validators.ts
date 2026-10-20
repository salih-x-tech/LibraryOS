import type { mongo } from "mongoose";

const id = { bsonType: "objectId" };
const date = { bsonType: "date" };
const token = { bsonType: "string", pattern: "^[a-z][a-zA-Z0-9_.-]{0,79}$" };
const digest = { bsonType: "string", pattern: "^[a-f0-9]{64}$" };
const integer = { bsonType: ["int", "long", "double"], minimum: 0, multipleOf: 1 };
const base = { _id: id, createdAt: date, updatedAt: date };
const scoped = { scopeKind: { enum: ["tenant", "global"] }, scopeKey: { bsonType: "string" }, organizationId: id };

function schema(properties: mongo.Document, required: string[]): mongo.Document {
  return { $jsonSchema: { bsonType: "object", additionalProperties: false, required: ["_id", "createdAt", "updatedAt", ...required], properties: { ...base, ...properties } } };
}

const scopeConstraint = { $or: [
  { scopeKind: "global", scopeKey: "global", organizationId: { $exists: false } },
  { scopeKind: "tenant", organizationId: { $type: "objectId" }, $expr: { $eq: ["$scopeKey", { $concat: ["tenant:", { $toString: "$organizationId" }] }] } },
] };

export const validators: Readonly<Record<string, mongo.Document>> = {
  auditEvents: { $and: [schema({
    ...scoped, actorId: id, systemIdentity: token, action: token, resourceType: token, resourceId: id,
    branchIds: { bsonType: "array", maxItems: 100, items: id }, timestamp: date,
    requestId: { bsonType: "string", pattern: "^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$" },
    changedFields: { bsonType: "array", maxItems: 50, items: token },
  }, ["scopeKind", "scopeKey", "action", "resourceType", "resourceId", "branchIds", "timestamp", "requestId", "changedFields"]), scopeConstraint,
  { $or: [{ actorId: { $type: "objectId" }, systemIdentity: { $exists: false } }, { actorId: { $exists: false }, systemIdentity: { $type: "string" } }] }] },
  outboxEvents: schema({
    organizationId: id, eventType: token, resourceId: id, eventKey: token,
    payload: { bsonType: "object", additionalProperties: false, properties: { recipientUserId: id, memberId: id } },
    status: { enum: ["pending", "processing", "delivered", "failed"] }, availableAt: date,
    leaseUntil: date, leaseToken: { bsonType: "string", minLength: 1, maxLength: 200 }, attemptCount: integer,
  }, ["organizationId", "eventType", "resourceId", "eventKey", "payload", "status", "availableAt", "attemptCount"]),
  idempotencyRecords: { $and: [schema({
    ...scoped, actorId: id, operation: token, keyHash: digest, requestHash: digest,
    status: { enum: ["pending", "completed"] }, responseStatus: { enum: [200, 201, 202] },
    responseJson: { bsonType: "string", maxLength: 65_536 }, expiresAt: date,
  }, ["scopeKind", "scopeKey", "actorId", "operation", "keyHash", "requestHash", "status", "expiresAt"]), scopeConstraint,
  { $or: [{ status: "pending", responseStatus: { $exists: false }, responseJson: { $exists: false } },
    { status: "completed", responseStatus: { $exists: true }, responseJson: { $exists: true } }] }] },
};
