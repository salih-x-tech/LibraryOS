import "server-only";
import { createHash } from "node:crypto";
import { mongo, type Connection } from "mongoose";
import { ApplicationError } from "@/server/http/errors";
import type { JsonValue } from "@/server/http/responses";
import { identifier, label, persistenceScope, type PersistenceScope } from "@/server/db/persistence";
import { runTransaction, type TransactionContext } from "@/server/db/transaction";
import { getIdempotencyModel, type IdempotencyRecord } from "./model";

export type StoredResult = Readonly<{ status: 200 | 201 | 202; data: JsonValue }>;
export type IdempotencyInput = Readonly<{
  scope: PersistenceScope;
  actorId: string;
  operation: string;
  key: string;
  request: JsonValue;
  // Required approved retention supplied by the service; no business default.
  retentionMs: number;
}>;

class ReservationRace extends ApplicationError {
  constructor() { super("CONFLICT"); }
}

// Hash normalized validated DTOs, never raw request streams or arbitrary objects.
export function canonicalJson(value: JsonValue): string {
  const seen = new Set<object>();
  function visit(item: JsonValue, depth: number): JsonValue {
    if (depth > 20) throw new ApplicationError("BAD_REQUEST");
    if (item === null || typeof item === "boolean" || typeof item === "string") return item;
    if (typeof item === "number" && Number.isFinite(item)) return item;
    if (typeof item !== "object" || seen.has(item)) throw new ApplicationError("BAD_REQUEST");
    seen.add(item);
    try {
      if (Array.isArray(item)) return item.map((entry) => visit(entry, depth + 1));
      if (Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) throw new ApplicationError("BAD_REQUEST");
      const record = item as Readonly<Record<string, JsonValue>>;
      const output: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
      for (const key of Object.keys(record).sort()) {
        if (["__proto__", "prototype", "constructor"].includes(key) || key.startsWith("$")) throw new ApplicationError("BAD_REQUEST");
        output[key] = visit(record[key]!, depth + 1);
      }
      return output;
    } finally { seen.delete(item); }
  }
  const encoded = JSON.stringify(visit(value, 0));
  if (Buffer.byteLength(encoded) > 65_536) throw new ApplicationError("BAD_REQUEST");
  return encoded;
}

function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }

function replay(record: IdempotencyRecord, requestHash: string): StoredResult {
  if (record.requestHash !== requestHash) throw new ApplicationError("CONFLICT");
  if (record.status !== "completed" || !record.responseJson) throw new ApplicationError("CONFLICT");
  const result: unknown = JSON.parse(record.responseJson);
  if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("Invalid stored result.");
  const data = result as Record<string, unknown>;
  if (Object.keys(data).length !== 2 || !Object.hasOwn(data, "data") || ![200, 201, 202].includes(Number(data.status))
    || data.status !== record.responseStatus) throw new Error("Invalid stored result.");
  canonicalJson(result as JsonValue);
  return result as StoredResult;
}

export async function executeIdempotent(
  connection: Connection,
  input: IdempotencyInput,
  authorize: (context: TransactionContext) => Promise<void>,
  work: (context: TransactionContext) => Promise<StoredResult>,
): Promise<StoredResult> {
  if (!/^[\x21-\x7e]{8,200}$/.test(input.key)) throw new ApplicationError("BAD_REQUEST");
  if (!Number.isSafeInteger(input.retentionMs) || input.retentionMs < 1 || input.retentionMs > 8_640_000_000_000_000 - Date.now()) {
    throw new Error("An explicit valid idempotency retention is required.");
  }
  const scoped = persistenceScope(input.scope);
  const lookup = { scopeKey: scoped.scopeKey, actorId: identifier(input.actorId), operation: label(input.operation), keyHash: hash(input.key) };
  const requestHash = hash(canonicalJson(input.request));
  const model = getIdempotencyModel(connection);

  try {
    return await runTransaction(connection, async (context) => {
      // Required even for replay. Critical services must revalidate guards here.
      await authorize(context);
      const now = new Date();
      const existing = await model.findOne(lookup).session(context.session).lean().exec();
      if (existing && existing.expiresAt > now) return replay(existing, requestHash);
      if (existing) await model.deleteOne({ ...lookup, _id: existing._id, expiresAt: { $lte: now } }).session(context.session).exec();
      try {
        await model.create([{
          ...scoped, ...lookup, requestHash, status: "pending", expiresAt: new Date(now.getTime() + input.retentionMs),
        }], { session: context.session });
      } catch (error: unknown) {
        if (error instanceof mongo.MongoServerError && error.code === 11000) throw new ReservationRace();
        throw error;
      }
      const result = await work(context);
      if (![200, 201, 202].includes(result.status)) throw new Error("Unsupported idempotent success status.");
      const responseJson = canonicalJson({ status: result.status, data: result.data });
      const update = await model.updateOne({ ...lookup, status: "pending" }, {
        $set: { status: "completed", responseStatus: result.status, responseJson, expiresAt: new Date(Date.now() + input.retentionMs) },
      }, { session: context.session, runValidators: true }).exec();
      if (update.modifiedCount !== 1) throw new Error("Idempotency reservation was lost.");
      // Normalize first execution and replay to the exact same JSON result.
      return JSON.parse(responseJson) as StoredResult;
    });
  } catch (error: unknown) {
    if (!(error instanceof ReservationRace) && !(error instanceof ApplicationError && error.code === "SERVICE_UNAVAILABLE")) throw error;
    // A duplicate race or lost commit acknowledgment may already have committed.
    // Only read/replay here; never rerun work in an outer retry loop.
    return runTransaction(connection, async (context) => {
      await authorize(context);
      const recorded = await model.findOne(lookup).session(context.session).lean().exec();
      if (recorded && recorded.expiresAt > new Date()) return replay(recorded, requestHash);
      throw error;
    });
  }
}
