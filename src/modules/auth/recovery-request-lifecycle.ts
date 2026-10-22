import "server-only";
import { createHash, randomBytes } from "node:crypto";
import type { Connection, mongo } from "mongoose";
import { ApplicationError } from "@/server/http/errors";
import { identifier, requestId, requireTransaction } from "@/server/db/persistence";
import { runTransaction, type TransactionContext } from "@/server/db/transaction";
import type { RequestContext } from "@/server/http/responses";
import { verifyInfrastructure } from "@/server/db/storage-contract";
import { appendAudit } from "@/modules/audit/append";
import { verifyRecoveryRequests } from "./recovery-request-storage";
import { SESSION_TOKEN_PATTERN } from "./session-format";
import type { ActionTokenPurpose } from "./action-token-format";
import { RECOVERY_REQUEST_LEASE_MS, RECOVERY_REQUEST_PENDING_MS, RECOVERY_REQUEST_TERMINAL_MS, RECOVERY_TERMINAL_STATES } from "./recovery-worker-policy";

function leaseHash(token: string): string {
  if (typeof token !== "string" || token.length !== 43 || !new RegExp(SESSION_TOKEN_PATTERN).test(token)) throw new ApplicationError("BAD_REQUEST");
  return createHash("sha256").update(JSON.stringify(["libraryos.recovery-lease.v1", token])).digest("hex");
}
const erase = ["ciphertext", "nonce", "tag", "leaseHash", "leaseUntil", "leaseFence"];
function terminalize(status: string | mongo.Document): mongo.Document[] {
  return [{ $set: { status, finishedAt: "$$NOW", purgeAfter: { $add: ["$$NOW", RECOVERY_REQUEST_TERMINAL_MS] } } }, { $unset: erase }];
}

// Explicit lifecycle operations only: no loop/scheduler, provider send or retry.
export async function createRecoveryRequestLifecycle(connection: Connection) {
  try { await verifyInfrastructure(connection); await verifyRecoveryRequests(connection); }
  catch { throw new ApplicationError("SERVICE_UNAVAILABLE"); }
  const records = connection.db!.collection("authRecoveryRequests");
  async function safe<T>(work: () => Promise<T>): Promise<T> {
    try { return await work(); } catch (error) {
      if (error instanceof ApplicationError) throw error;
      throw new ApplicationError("SERVICE_UNAVAILABLE");
    }
  }
  async function audit(transaction: TransactionContext, id: string, action: string, context: RequestContext) {
    await appendAudit(connection, transaction, { scope: { kind: "global" }, actor: { systemIdentity: "authRecoveryWorker" },
      action, resourceType: "recoveryRequest", resourceId: id, branchIds: [], requestId: requestId(context.requestId), changedFields: ["status"] });
  }
  const live = (id: string, token: string) => ({ _id: identifier(id), status: "processing", leaseHash: leaseHash(token), $expr: { $gt: ["$leaseUntil", "$$NOW"] } });

  async function claim(context: RequestContext) {
    return safe(async () => {
      const token = randomBytes(32).toString("base64url"); const hash = leaseHash(token);
      return runTransaction(connection, async (transaction) => {
        const record = await records.findOneAndUpdate({ status: "pending", $expr: { $gt: ["$createdAt", { $subtract: ["$$NOW", RECOVERY_REQUEST_PENDING_MS] }] } },
          [{ $set: { status: "processing", leaseHash: hash, leaseFence: 0, claimedAt: "$$NOW", leaseUntil: { $add: ["$$NOW", RECOVERY_REQUEST_LEASE_MS] } } }],
          { sort: { createdAt: 1, _id: 1 }, session: transaction.session, returnDocument: "after" });
        if (!record) return null;
        await audit(transaction, record._id.toHexString(), "auth.recoveryClaimed", context);
        return Object.freeze({ id: record._id.toHexString(), purpose: record.purpose as ActionTokenPurpose, requestId: record.requestId as string,
          ciphertext: record.ciphertext as string, nonce: record.nonce as string, tag: record.tag as string, leaseToken: token });
      });
    });
  }
  async function isLive(id: string, token: string): Promise<boolean> {
    return safe(async () => Boolean(await records.findOne(live(id, token), { projection: { _id: 1 }, maxTimeMS: 5000 })));
  }
  async function guard(transaction: TransactionContext, id: string, token: string): Promise<void> {
    requireTransaction(transaction);
    const changed = await records.updateOne({ ...live(id, token), leaseFence: { $lt: Number.MAX_SAFE_INTEGER } },
      { $inc: { leaseFence: 1 } }, { session: transaction.session });
    if (changed.modifiedCount !== 1) throw new ApplicationError("CONFLICT");
  }
  async function finalize(id: string, token: string, outcome: "completed" | "failed" | "uncertain", context: RequestContext): Promise<boolean> {
    return safe(async () => {
      if (!["completed", "failed", "uncertain"].includes(outcome)) throw new ApplicationError("BAD_REQUEST");
      return runTransaction(connection, async (transaction) => {
        const record = await records.findOneAndUpdate(live(id, token), terminalize(outcome), { session: transaction.session, returnDocument: "after" });
        if (!record) return false;
        await audit(transaction, id, "auth.recoveryTerminal", context); return true;
      });
    });
  }
  async function expireOne(context: RequestContext): Promise<boolean> {
    return safe(() => runTransaction(connection, async (transaction) => {
      const record = await records.findOneAndUpdate({ $or: [
        { status: "pending", $expr: { $lte: ["$createdAt", { $subtract: ["$$NOW", RECOVERY_REQUEST_PENDING_MS] }] } },
        { status: "processing", $expr: { $lte: ["$leaseUntil", "$$NOW"] } },
      ] }, terminalize({ $cond: [{ $eq: ["$status", "processing"] }, "uncertain", "expired"] }),
      { sort: { createdAt: 1, _id: 1 }, session: transaction.session, returnDocument: "after" });
      if (!record) return false;
      await audit(transaction, record._id.toHexString(), "auth.recoveryTerminal", context); return true;
    }));
  }
  async function purgeOne(context: RequestContext): Promise<boolean> {
    return safe(() => runTransaction(connection, async (transaction) => {
      const record = await records.findOneAndDelete({ status: { $in: [...RECOVERY_TERMINAL_STATES] }, $expr: { $lte: ["$purgeAfter", "$$NOW"] } },
        { sort: { purgeAfter: 1, _id: 1 }, session: transaction.session });
      if (!record) return false;
      await audit(transaction, record._id.toHexString(), "auth.recoveryPurged", context); return true;
    }));
  }
  return Object.freeze({ claim, isLive, guard, finalize, expireOne, purgeOne });
}
