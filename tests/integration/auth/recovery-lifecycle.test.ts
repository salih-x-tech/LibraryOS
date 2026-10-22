import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { startIsolatedDatabase } from "../helpers/database";
import { deployInfrastructure } from "../../../scripts/db/indexes";
import { deployRecoveryRequests } from "../../../scripts/db/recovery-requests";
import { createRecoveryRequestQueue } from "@/modules/auth/recovery-requests";
import { createRecoveryRequestLifecycle } from "@/modules/auth/recovery-request-lifecycle";
import { createRequestContext } from "@/server/http/responses";
import { runTransaction } from "@/server/db/transaction";
import { validators } from "@/server/db/validators";
import { createSessionCredential } from "@/modules/auth/sessions";
import { RECOVERY_REQUEST_LEASE_MS, RECOVERY_REQUEST_PENDING_MS, RECOVERY_REQUEST_TERMINAL_MS } from "@/modules/auth/recovery-worker-policy";

let fixture: Awaited<ReturnType<typeof startIsolatedDatabase>>;
let lifecycle: Awaited<ReturnType<typeof createRecoveryRequestLifecycle>>;
let queue: Awaited<ReturnType<typeof createRecoveryRequestQueue>>;
const context = () => createRequestContext();
beforeAll(async () => { fixture = await startIsolatedDatabase(); });
beforeEach(async () => {
  await fixture.clear(); const connection = await fixture.manager.get();
  await deployInfrastructure(connection); await deployRecoveryRequests(connection);
  queue = await createRecoveryRequestQueue(connection, { checkRequest: async () => {} }, Buffer.alloc(32, 7));
  lifecycle = await createRecoveryRequestLifecycle(connection);
});
afterAll(async () => { await fixture?.stop(); });
async function enqueue() { await queue.enqueue("reset-password", "reader@example.com", "192.0.2.1", context()); }

it("has one concurrent claim winner, stores only a lease hash and cannot reclaim processing", async () => {
  await enqueue();
  const outcomes = await Promise.all([lifecycle.claim(context()), lifecycle.claim(context()), lifecycle.claim(context())]);
  const claimed = outcomes.filter(Boolean); expect(claimed).toHaveLength(1);
  const lease = claimed[0]!;
  const record = await (await fixture.manager.get()).db!.collection("authRecoveryRequests").findOne();
  expect(JSON.stringify(record)).not.toContain(lease.leaseToken);
  expect(record!.leaseUntil.getTime() - record!.claimedAt.getTime()).toBe(RECOVERY_REQUEST_LEASE_MS);
  expect(await lifecycle.isLive(lease.id, lease.leaseToken)).toBe(true);
  expect(await lifecycle.isLive(lease.id, createSessionCredential().token)).toBe(false);
  expect(await lifecycle.claim(context())).toBeNull();
});

it("finalizes once, erases encrypted payload/lease fields and retains exact seven-day metadata", async () => {
  await enqueue(); const lease = (await lifecycle.claim(context()))!;
  expect(await lifecycle.finalize(lease.id, createSessionCredential().token, "completed", context())).toBe(false);
  expect(await lifecycle.finalize(lease.id, lease.leaseToken, "completed", context())).toBe(true);
  expect(await lifecycle.finalize(lease.id, lease.leaseToken, "failed", context())).toBe(false);
  const record = (await (await fixture.manager.get()).db!.collection("authRecoveryRequests").findOne())!;
  for (const field of ["ciphertext", "nonce", "tag", "leaseHash", "leaseUntil", "leaseFence"]) expect(record).not.toHaveProperty(field);
  expect(record.status).toBe("completed");
  expect(record.purgeAfter.getTime() - record.finishedAt.getTime()).toBe(RECOVERY_REQUEST_TERMINAL_MS);
  expect(await lifecycle.purgeOne(context())).toBe(false);
});

it("marks expired claims uncertain without reclaiming or accepting late finalization", async () => {
  await enqueue(); const lease = (await lifecycle.claim(context()))!;
  const db = (await fixture.manager.get()).db!;
  const claimedAt = new Date(Date.now() - RECOVERY_REQUEST_LEASE_MS - 60_000);
  await db.collection("authRecoveryRequests").updateOne({}, { $set: { claimedAt, leaseUntil: new Date(claimedAt.getTime() + RECOVERY_REQUEST_LEASE_MS) } });
  expect(await lifecycle.isLive(lease.id, lease.leaseToken)).toBe(false);
  expect(await lifecycle.finalize(lease.id, lease.leaseToken, "completed", context())).toBe(false);
  expect(await lifecycle.claim(context())).toBeNull();
  expect(await lifecycle.expireOne(context())).toBe(true);
  const record = (await db.collection("authRecoveryRequests").findOne())!;
  expect(record.status).toBe("uncertain"); expect(record).not.toHaveProperty("ciphertext");
  expect(await lifecycle.claim(context())).toBeNull();
});

it("expires unprocessed intents after 24 hours without claiming or sending", async () => {
  await enqueue(); const collection = (await fixture.manager.get()).db!.collection("authRecoveryRequests");
  await collection.updateOne({}, { $set: { createdAt: new Date(Date.now() - RECOVERY_REQUEST_PENDING_MS - 60_000) } });
  expect(await lifecycle.claim(context())).toBeNull(); expect(await lifecycle.expireOne(context())).toBe(true);
  const record = (await collection.findOne())!; expect(record.status).toBe("expired"); expect(record).not.toHaveProperty("ciphertext");
});

it("rolls back terminalization and encrypted-data erasure when audit fails", async () => {
  await enqueue(); const lease = (await lifecycle.claim(context()))!;
  const db = (await fixture.manager.get()).db!;
  await db.command({ collMod: "auditEvents", validator: { $expr: { $eq: [1, 0] } } });
  await expect(lifecycle.finalize(lease.id, lease.leaseToken, "failed", context())).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
  expect(await db.collection("authRecoveryRequests").findOne()).toMatchObject({ status: "processing", ciphertext: expect.any(String) });
  await db.command({ collMod: "auditEvents", validator: validators.auditEvents });
  expect(await lifecycle.finalize(lease.id, lease.leaseToken, "failed", context())).toBe(true);
});

it("purges only aged terminal queue metadata and preserves audit and unrelated data", async () => {
  await enqueue(); const lease = (await lifecycle.claim(context()))!;
  await lifecycle.finalize(lease.id, lease.leaseToken, "completed", context());
  const db = (await fixture.manager.get()).db!;
  const finishedAt = new Date(Date.now() - RECOVERY_REQUEST_TERMINAL_MS - 60_000);
  await db.collection("authRecoveryRequests").updateOne({}, { $set: { finishedAt, purgeAfter: new Date(finishedAt.getTime() + RECOVERY_REQUEST_TERMINAL_MS) } });
  await enqueue(); await db.collection("unrelatedFixture").insertOne({ keep: true });
  const before = await db.collection("auditEvents").countDocuments();
  expect(await lifecycle.purgeOne(context())).toBe(true); expect(await lifecycle.purgeOne(context())).toBe(false);
  expect(await db.collection("authRecoveryRequests").countDocuments({ status: "pending" })).toBe(1);
  expect(await db.collection("auditEvents").countDocuments()).toBe(before + 1);
  expect(await db.collection("unrelatedFixture").countDocuments()).toBe(1);
});

it("guards token issuance transactions and refuses stale lease holders", async () => {
  await enqueue(); const lease = (await lifecycle.claim(context()))!;
  const connection = await fixture.manager.get();
  await runTransaction(connection, (transaction) => lifecycle.guard(transaction, lease.id, lease.leaseToken));
  await lifecycle.finalize(lease.id, lease.leaseToken, "uncertain", context());
  await expect(runTransaction(connection, (transaction) => lifecycle.guard(transaction, lease.id, lease.leaseToken))).rejects.toMatchObject({ code: "CONFLICT" });
});

it("enforces state-dependent payload erasure in database validation", async () => {
  await enqueue(); const db = (await fixture.manager.get()).db!;
  const finishedAt = new Date();
  await expect(db.collection("authRecoveryRequests").updateOne({}, { $set: { status: "completed", finishedAt, purgeAfter: new Date(finishedAt.getTime() + RECOVERY_REQUEST_TERMINAL_MS) } })).rejects.toMatchObject({ code: 121 });
});

it("rolls back both claim and metadata deletion if their audit writes fail", async () => {
  await enqueue(); const db = (await fixture.manager.get()).db!;
  const breakAudit = () => db.command({ collMod: "auditEvents", validator: { $expr: { $eq: [1, 0] } } });
  const restoreAudit = () => db.command({ collMod: "auditEvents", validator: validators.auditEvents });
  await breakAudit();
  await expect(lifecycle.claim(context())).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
  expect(await db.collection("authRecoveryRequests").findOne()).toMatchObject({ status: "pending", ciphertext: expect.any(String) });
  await restoreAudit();
  const lease = (await lifecycle.claim(context()))!; await lifecycle.finalize(lease.id, lease.leaseToken, "completed", context());
  const finishedAt = new Date(Date.now() - RECOVERY_REQUEST_TERMINAL_MS - 60_000);
  await db.collection("authRecoveryRequests").updateOne({}, { $set: { finishedAt, purgeAfter: new Date(finishedAt.getTime() + RECOVERY_REQUEST_TERMINAL_MS) } });
  const auditCount = await db.collection("auditEvents").countDocuments(); await breakAudit();
  await expect(lifecycle.purgeOne(context())).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
  expect(await db.collection("authRecoveryRequests").countDocuments()).toBe(1);
  expect(await db.collection("auditEvents").countDocuments()).toBe(auditCount); await restoreAudit();
});
