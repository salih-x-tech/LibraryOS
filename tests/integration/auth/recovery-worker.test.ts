import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { startIsolatedDatabase } from "../helpers/database";
import { deployInfrastructure } from "../../../scripts/db/indexes";
import { deployAuthStorage } from "../../../scripts/db/auth";
import { deployActionTokens } from "../../../scripts/db/action-tokens";
import { deployRecoveryRequests } from "../../../scripts/db/recovery-requests";
import { createMongoRateLimiter } from "@/server/security/rate-limit";
import { createRecoveryRequestQueue } from "@/modules/auth/recovery-requests";
import { createRecoveryDeliveryWorker } from "@/modules/auth/recovery-delivery-worker";
import { createRecoveryRequestLifecycle } from "@/modules/auth/recovery-request-lifecycle";
import { createTestRecoveryService } from "@/modules/auth/recovery-service";
import { createRequestContext } from "@/server/http/responses";
import { getUserModel } from "@/modules/auth/user-model";
import { hashPassword } from "@/modules/auth/passwords";
import { RECOVERY_REQUEST_LEASE_MS } from "@/modules/auth/recovery-worker-policy";
import { validators } from "@/server/db/validators";

let fixture: Awaited<ReturnType<typeof startIsolatedDatabase>>;
let queue: Awaited<ReturnType<typeof createRecoveryRequestQueue>>;
let worker: Awaited<ReturnType<typeof createRecoveryDeliveryWorker>>;
let service: Awaited<ReturnType<typeof createTestRecoveryService>>;
let passwordHash: string;
const email = "reader@example.com";
const ready = vi.fn(); const send = vi.fn();
const key = Buffer.alloc(32, 7);
const context = () => createRequestContext();
beforeAll(async () => { fixture = await startIsolatedDatabase(); passwordHash = await hashPassword("Synthetic original passphrase!"); });
beforeEach(async () => {
  await fixture.clear(); ready.mockReset().mockResolvedValue(undefined); send.mockReset().mockResolvedValue(undefined);
  const connection = await fixture.manager.get();
  await deployInfrastructure(connection); await deployAuthStorage(connection); await deployActionTokens(connection); await deployRecoveryRequests(connection);
  await getUserModel(connection).create({ normalizedEmail: email, passwordHash, status: "active", verifiedAt: new Date(), sessionVersion: 0, authorizationVersion: 0, operationFence: 0 });
  const limiter = await createMongoRateLimiter(connection, Buffer.alloc(32, 8));
  queue = await createRecoveryRequestQueue(connection, limiter, key);
  service = await createTestRecoveryService(connection, limiter, { kind: "synthetic-memory", ready, send },
    { origin: "https://127.0.0.1:3102", blocklist: ["a compromised test phrase"] });
  worker = await createRecoveryDeliveryWorker(connection, key, service, { ready, send });
});
afterAll(async () => { await fixture?.stop(); });
async function enqueue(address = email) { await queue.enqueue("reset-password", address, "192.0.2.1", context()); }

it("guards issuance and delivers only after commit without charging admission twice", async () => {
  const db = (await fixture.manager.get()).db!;
  send.mockImplementationOnce(async () => {
    expect(await db.collection("authActionTokens").countDocuments()).toBe(1);
    expect(await db.collection("auditEvents").countDocuments({ action: "auth.tokenRequested" })).toBe(1);
    expect(await db.collection("authRecoveryRequests").findOne()).toMatchObject({ status: "processing", leaseFence: 1 });
  });
  await enqueue();
  expect(ready).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled();
  expect(await worker.processOne(context())).toEqual({ processed: true, finalized: true });
  expect(ready).toHaveBeenCalledOnce(); expect(send).toHaveBeenCalledOnce();
  expect(await db.collection("rateLimitBuckets").findOne({ kind: "recovery.account" })).toMatchObject({ count: 1 });
  const job = (await db.collection("authRecoveryRequests").findOne())!;
  expect(job.status).toBe("completed"); expect(job).not.toHaveProperty("ciphertext");
  const token = new URL(send.mock.calls[0]![0].url).hash.slice("#token=".length);
  expect(JSON.stringify(await db.collection("authActionTokens").find().toArray())).not.toContain(token);
  expect(JSON.stringify(await db.collection("auditEvents").find().toArray())).not.toContain(email);
});

it("permits one competing processor and never resends a completed job", async () => {
  await enqueue();
  const results = await Promise.all([worker.processOne(context()), worker.processOne(context())]);
  expect(results.filter((result) => result.processed)).toHaveLength(1); expect(send).toHaveBeenCalledOnce();
  expect(await worker.processOne(context())).toEqual({ processed: false, finalized: false });
  expect(send).toHaveBeenCalledOnce();
});

it("completes unknown and newly suspended accounts without exposing eligibility or sending", async () => {
  await enqueue("unknown@example.com"); await enqueue();
  const connection = await fixture.manager.get(); await getUserModel(connection).updateOne({}, { $set: { status: "suspended" } });
  expect(await worker.processOne(context())).toEqual({ processed: true, finalized: true });
  expect(await worker.processOne(context())).toEqual({ processed: true, finalized: true });
  expect(send).not.toHaveBeenCalled();
  expect(await connection.db!.collection("authRecoveryRequests").countDocuments({ status: "completed" })).toBe(2);
  expect(await connection.db!.collection("authActionTokens").countDocuments()).toBe(0);
});

it("marks known pre-send failures failed without creating an action token", async () => {
  await enqueue(); ready.mockRejectedValueOnce(new Error("private SMTP auth detail"));
  expect(await worker.processOne(context())).toEqual({ processed: true, finalized: true });
  const db = (await fixture.manager.get()).db!;
  expect(await db.collection("authRecoveryRequests").findOne()).toMatchObject({ status: "failed" });
  expect(await db.collection("authActionTokens").countDocuments()).toBe(0); expect(send).not.toHaveBeenCalled();
});

it("marks ambiguous sends uncertain and never retries or requeues", async () => {
  await enqueue(); send.mockRejectedValueOnce(new Error("lost acknowledgment after possible delivery"));
  expect(await worker.processOne(context())).toEqual({ processed: true, finalized: true });
  const record = (await (await fixture.manager.get()).db!.collection("authRecoveryRequests").findOne())!;
  expect(record.status).toBe("uncertain"); expect(record).not.toHaveProperty("ciphertext");
  expect(await worker.processOne(context())).toEqual({ processed: false, finalized: false }); expect(send).toHaveBeenCalledOnce();
});

it("refuses issuance/send when the lease expires during provider readiness", async () => {
  await enqueue(); const connection = await fixture.manager.get();
  ready.mockImplementationOnce(async () => {
    const claimedAt = new Date(Date.now() - RECOVERY_REQUEST_LEASE_MS - 60_000);
    await connection.db!.collection("authRecoveryRequests").updateOne({}, { $set: { claimedAt, leaseUntil: new Date(claimedAt.getTime() + RECOVERY_REQUEST_LEASE_MS) } });
  });
  expect(await worker.processOne(context())).toEqual({ processed: true, finalized: false });
  expect(await connection.db!.collection("authActionTokens").countDocuments()).toBe(0); expect(send).not.toHaveBeenCalled();
  const lifecycle = await createRecoveryRequestLifecycle(connection); await lifecycle.expireOne(context());
  expect(await connection.db!.collection("authRecoveryRequests").findOne()).toMatchObject({ status: "uncertain" });
});

it("never sends uncommitted tokens and leaves audit-failure jobs unreclaimable", async () => {
  await enqueue(); const connection = await fixture.manager.get(); const db = connection.db!;
  ready.mockImplementationOnce(async () => { await db.command({ collMod: "auditEvents", validator: { $expr: { $eq: [1, 0] } } }); });
  await expect(worker.processOne(context())).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
  expect(send).not.toHaveBeenCalled(); expect(await db.collection("authActionTokens").countDocuments()).toBe(0);
  expect(await db.collection("authRecoveryRequests").findOne()).toMatchObject({ status: "processing" });
  await db.command({ collMod: "auditEvents", validator: validators.auditEvents });
  expect(await worker.processOne(context())).toEqual({ processed: false, finalized: false });
});

it("rechecks ownership after token commit and refuses a send under an expired lease", async () => {
  await enqueue(); const connection = await fixture.manager.get();
  const expiringIssuer = { issueForDelivery: async (...args: Parameters<typeof service.issueForDelivery>) => {
    const message = await service.issueForDelivery(...args);
    const claimedAt = new Date(Date.now() - RECOVERY_REQUEST_LEASE_MS - 60_000);
    await connection.db!.collection("authRecoveryRequests").updateOne({},
      { $set: { claimedAt, leaseUntil: new Date(claimedAt.getTime() + RECOVERY_REQUEST_LEASE_MS) } }, { session: args[0].session });
    return message;
  } };
  const processor = await createRecoveryDeliveryWorker(connection, key, expiringIssuer, { ready, send });
  expect(await processor.processOne(context())).toEqual({ processed: true, finalized: false });
  expect(await connection.db!.collection("authActionTokens").countDocuments()).toBe(1);
  expect(send).not.toHaveBeenCalled();
});

it("treats unreadable intent payload as a pre-send failure and erases it", async () => {
  await enqueue(); const connection = await fixture.manager.get();
  const processor = await createRecoveryDeliveryWorker(connection, Buffer.alloc(32, 11), service, { ready, send });
  expect(await processor.processOne(context())).toEqual({ processed: true, finalized: true });
  expect(ready).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled();
  const record = (await connection.db!.collection("authRecoveryRequests").findOne())!;
  expect(record.status).toBe("failed"); expect(record).not.toHaveProperty("ciphertext");
});

it("does not resend when delivery succeeds but terminal audit cannot commit", async () => {
  await enqueue(); const connection = await fixture.manager.get(); const db = connection.db!;
  send.mockImplementationOnce(async () => { await db.command({ collMod: "auditEvents", validator: { $expr: { $eq: [1, 0] } } }); });
  await expect(worker.processOne(context())).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
  expect(send).toHaveBeenCalledOnce();
  await db.command({ collMod: "auditEvents", validator: validators.auditEvents });
  expect(await worker.processOne(context())).toEqual({ processed: false, finalized: false });
  const claimedAt = new Date(Date.now() - RECOVERY_REQUEST_LEASE_MS - 60_000);
  await db.collection("authRecoveryRequests").updateOne({}, { $set: { claimedAt, leaseUntil: new Date(claimedAt.getTime() + RECOVERY_REQUEST_LEASE_MS) } });
  const lifecycle = await createRecoveryRequestLifecycle(connection); await lifecycle.expireOne(context());
  expect(await db.collection("authRecoveryRequests").findOne()).toMatchObject({ status: "uncertain" });
  expect(send).toHaveBeenCalledOnce();
});
