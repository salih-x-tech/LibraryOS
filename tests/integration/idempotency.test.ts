import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mongo, Types } from "mongoose";
import { startIsolatedDatabase } from "./helpers/database";
import { deployInfrastructure, verifyInfrastructure } from "../../scripts/db/indexes";
import { executeIdempotent, type IdempotencyInput } from "@/server/idempotency/service";
import type { TransactionContext } from "@/server/db/transaction";
import { ApplicationError } from "@/server/http/errors";
import { appendAudit } from "@/modules/audit/append";
import { publishOutbox } from "@/modules/notifications/publish";
import { createTenantScope } from "@/server/db/scope";
import { createRequestContext } from "@/server/http/responses";

let fixture: Awaited<ReturnType<typeof startIsolatedDatabase>>;
const orgA = new Types.ObjectId().toHexString();
const orgB = new Types.ObjectId().toHexString();
const actor = new Types.ObjectId().toHexString();
const input: IdempotencyInput = {
  scope: { kind: "tenant", organizationId: orgA }, actorId: actor, operation: "probe.create",
  key: "test-key-12345678", request: { value: 1 }, retentionMs: 60_000, // test-only fixture policy
};
const authorize = async () => {};
beforeAll(async () => { fixture = await startIsolatedDatabase(); });
beforeEach(async () => {
  await fixture.clear();
  const connection = await fixture.manager.get();
  await deployInfrastructure(connection);
  await connection.db!.createCollection("connection_probes");
});
afterAll(async () => { await fixture?.stop(); });

async function writeProbe(context: TransactionContext) {
  const db = (await fixture.manager.get()).db!;
  const id = new Types.ObjectId();
  await db.collection("connection_probes").insertOne({ _id: id, value: 1 }, { session: context.session });
  return { status: 201 as const, data: { id: id.toHexString() } };
}

async function writeProbeWithEvents(context: TransactionContext) {
  const result = await writeProbe(context);
  const connection = await fixture.manager.get();
  await appendAudit(connection, context, {
    scope: { kind: "tenant", organizationId: orgA }, actor: { userId: actor },
    action: "probe.created", resourceType: "probe", resourceId: result.data.id,
    branchIds: [], requestId: createRequestContext().requestId, changedFields: ["value"],
  });
  await publishOutbox(connection, context, createTenantScope(orgA), {
    eventType: "probe.created", eventKey: `probe.${result.data.id}`, resourceId: result.data.id, payload: {},
  });
  return result;
}

describe("durable idempotency and deployment constraints", () => {
  it("deploys repeatably, detects missing/drifted indexes and rejects invalid raw writes", async () => {
    const connection = await fixture.manager.get();
    await deployInfrastructure(connection);
    await connection.db!.collection("auditEvents").createIndex({ timestamp: 1 }, { name: "unapproved_retention", expireAfterSeconds: 100 });
    await expect(verifyInfrastructure(connection)).rejects.toThrow("Retention");
    await connection.db!.collection("auditEvents").dropIndex("unapproved_retention");
    await verifyInfrastructure(connection);
    await expect(connection.db!.collection("outboxEvents").insertOne({ organizationId: new Types.ObjectId() })).rejects.toMatchObject({ code: 121 });
    await connection.db!.collection("outboxEvents").dropIndex("outbox_tenant_event_unique");
    await expect(verifyInfrastructure(connection)).rejects.toThrow("index");
    await deployInfrastructure(connection);
    await connection.db!.command({ collMod: "outboxEvents", validationAction: "warn" });
    await expect(verifyInfrastructure(connection)).rejects.toThrow("validation");
    await deployInfrastructure(connection);
  });
  it("replays the recorded result, reauthorizes and stores only request/key hashes", async () => {
    const connection = await fixture.manager.get();
    const auth = vi.fn(authorize);
    const first = await executeIdempotent(connection, input, auth, writeProbeWithEvents);
    const work = vi.fn(writeProbe);
    expect(await executeIdempotent(connection, input, auth, work)).toEqual(first);
    expect(work).not.toHaveBeenCalled();
    expect(auth).toHaveBeenCalledTimes(2);
    expect(await connection.db!.collection("connection_probes").countDocuments()).toBe(1);
    expect(await connection.db!.collection("auditEvents").countDocuments()).toBe(1);
    expect(await connection.db!.collection("outboxEvents").countDocuments()).toBe(1);
    const stored = await connection.db!.collection("idempotencyRecords").findOne();
    expect(stored?.keyHash).toMatch(/^[a-f0-9]{64}$/);
    expect(stored?.requestHash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(stored)).not.toContain(input.key);
  });
  it("rejects raw duplicates, scope inconsistencies and unsafe completed records", async () => {
    const connection = await fixture.manager.get();
    await executeIdempotent(connection, input, authorize, writeProbe);
    const records = connection.db!.collection("idempotencyRecords");
    const stored = (await records.findOne())!;
    await expect(records.insertOne({ ...stored, _id: new Types.ObjectId() })).rejects.toMatchObject({ code: 11000 });
    await expect(records.insertOne({ ...stored, _id: new Types.ObjectId(), scopeKind: "global" })).rejects.toMatchObject({ code: 121 });
    const { responseJson: omitted, ...withoutResult } = stored;
    expect(omitted).toBeDefined();
    await expect(records.insertOne({ ...withoutResult, _id: new Types.ObjectId(), keyHash: "a".repeat(64) })).rejects.toMatchObject({ code: 121 });
    const ttl = (await records.listIndexes().toArray()).find((index) => index.name === "idempotency_expiry");
    expect(ttl?.expireAfterSeconds).toBe(0);
  });
  it("rejects changed body and revoked replay without running work", async () => {
    const connection = await fixture.manager.get();
    await executeIdempotent(connection, input, authorize, writeProbe);
    const work = vi.fn(writeProbe);
    await expect(executeIdempotent(connection, { ...input, request: { value: 2 } }, authorize, work)).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(executeIdempotent(connection, input, async () => { throw new ApplicationError("FORBIDDEN"); }, work)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(work).not.toHaveBeenCalled();
  });
  it("separates organizations, actors, operations and explicit global scope", async () => {
    const connection = await fixture.manager.get();
    for (const variant of [input,
      { ...input, scope: { kind: "tenant" as const, organizationId: orgB } },
      { ...input, actorId: new Types.ObjectId().toHexString() },
      { ...input, operation: "probe.other" }, { ...input, scope: { kind: "global" as const } },
    ]) await executeIdempotent(connection, variant, authorize, writeProbe);
    expect(await connection.db!.collection("connection_probes").countDocuments()).toBe(5);
    const global = await connection.db!.collection("idempotencyRecords").findOne({ scopeKind: "global" });
    expect(global?.scopeKey).toBe("global");
    expect(global).not.toHaveProperty("organizationId");
  });
  it("arbitrates concurrent callers to one effect and one result", async () => {
    const connection = await fixture.manager.get();
    const results = await Promise.all(Array.from({ length: 4 }, () => executeIdempotent(connection, input, authorize, writeProbe)));
    expect(results.every((result) => JSON.stringify(result) === JSON.stringify(results[0]))).toBe(true);
    expect(await connection.db!.collection("connection_probes").countDocuments()).toBe(1);
    expect(await connection.db!.collection("idempotencyRecords").countDocuments()).toBe(1);
  });
  it("rolls back reservation and effects if work fails", async () => {
    const connection = await fixture.manager.get();
    await expect(executeIdempotent(connection, input, authorize, async (context) => {
      await writeProbeWithEvents(context);
      throw new ApplicationError("CONFLICT");
    })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await connection.db!.collection("connection_probes").countDocuments()).toBe(0);
    expect(await connection.db!.collection("idempotencyRecords").countDocuments()).toBe(0);
    expect(await connection.db!.collection("auditEvents").countDocuments()).toBe(0);
    expect(await connection.db!.collection("outboxEvents").countDocuments()).toBe(0);
  });
  it("checks expiry in application logic without waiting for TTL deletion", async () => {
    const connection = await fixture.manager.get();
    await executeIdempotent(connection, input, authorize, writeProbe);
    await connection.db!.collection("idempotencyRecords").updateOne({}, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    await executeIdempotent(connection, input, authorize, writeProbe);
    expect(await connection.db!.collection("connection_probes").countDocuments()).toBe(2);
    expect(await connection.db!.collection("idempotencyRecords").countDocuments()).toBe(1);
  });
  it("retries a transient failure after all event writes without duplicating any collection", async () => {
    const connection = await fixture.manager.get();
    let attempts = 0;
    await executeIdempotent(connection, input, authorize, async (context) => {
      attempts++;
      const result = await writeProbeWithEvents(context);
      if (attempts === 1) {
        const transient = new mongo.MongoServerError({ message: "synthetic retry after event writes", code: 112 });
        transient.addErrorLabel("TransientTransactionError");
        throw transient;
      }
      return result;
    });
    expect(attempts).toBe(2);
    for (const name of ["connection_probes", "auditEvents", "outboxEvents", "idempotencyRecords"]) {
      expect(await connection.db!.collection(name).countDocuments()).toBe(1);
    }
  });
  it("resolves a lost final acknowledgment by reading the result without rerunning work", async () => {
    const connection = await fixture.manager.get();
    const transaction = connection.transaction.bind(connection);
    vi.spyOn(connection, "transaction").mockImplementationOnce(async (...args) => {
      await transaction(...args);
      throw new Error("synthetic lost final acknowledgment");
    });
    const work = vi.fn(writeProbe);
    const result = await executeIdempotent(connection, input, authorize, work);
    expect(result.status).toBe(201);
    expect(work).toHaveBeenCalledTimes(1);
    expect(await connection.db!.collection("connection_probes").countDocuments()).toBe(1);
  });
  it("lets the real driver retry an unknown commit result without redoing callback effects", async () => {
    const connection = await fixture.manager.get();
    const startSession = connection.startSession.bind(connection);
    vi.spyOn(connection, "startSession").mockImplementationOnce(async (...args) => {
      const session = await startSession(...args);
      const commit = session.commitTransaction.bind(session);
      vi.spyOn(session, "commitTransaction").mockImplementationOnce(async (...commitArgs) => {
        await commit(...commitArgs);
        const error = new mongo.MongoServerError({ message: "synthetic unknown commit outcome" });
        error.addErrorLabel("UnknownTransactionCommitResult");
        throw error;
      });
      return session;
    });
    const work = vi.fn(writeProbe);
    expect((await executeIdempotent(connection, input, authorize, work)).status).toBe(201);
    expect(work).toHaveBeenCalledTimes(1);
    expect(await connection.db!.collection("connection_probes").countDocuments()).toBe(1);
  });
});
