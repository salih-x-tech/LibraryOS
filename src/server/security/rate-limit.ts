import "server-only";
import { createHmac } from "node:crypto";
import { isIP } from "node:net";
import { Types, mongo, type Connection, type ClientSession } from "mongoose";
import { normalizeEmail } from "@/modules/auth/validation";
import { ApplicationError, RateLimitError } from "@/server/http/errors";
import { runTransaction } from "@/server/db/transaction";
import { ATTEMPT_COLLECTION, BUCKET_COLLECTION, RATE_LIMIT_POLICIES, verifyRateLimitStorage, type RateLimitKind } from "./rate-limit-contract";

type Bucket = {
  _id: string; kind: RateLimitKind; windowId: Types.ObjectId; count: number;
  admitted: boolean; retryAfterSeconds: number; expiresAt: Date; createdAt: Date; updatedAt: Date;
};
type Attempt = {
  _id: Types.ObjectId; bucketKey: string; windowId: Types.ObjectId;
  status: "pending" | "success" | "failure"; expiresAt: Date; createdAt: Date; updatedAt: Date;
};
export type LoginOutcome = "success" | "failure";
export type LoginPermit = Readonly<{ complete: (outcome: LoginOutcome) => Promise<void> }>;

export function normalizeTrustedIp(value: string): string {
  if (typeof value !== "string" || value.includes("%") || !isIP(value)) throw new Error("A trusted client IP is required.");
  if (isIP(value) === 4) return value;
  const normalized = new URL(`http://[${value}]`).hostname.slice(1, -1);
  const mapped = /^::ffff:([a-f0-9]{1,4}):([a-f0-9]{1,4})$/.exec(normalized);
  if (!mapped) return normalized;
  const high = parseInt(mapped[1]!, 16);
  const low = parseInt(mapped[2]!, 16);
  return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
}

export async function createMongoRateLimiter(connection: Connection, secret: Uint8Array) {
  if (!(secret instanceof Uint8Array) || secret.byteLength < 32) throw new Error("Limiter keys require at least 32 secret bytes.");
  const key = Buffer.from(secret);
  try { await verifyRateLimitStorage(connection); } catch { throw new ApplicationError("SERVICE_UNAVAILABLE"); }
  const buckets = connection.db!.collection<Bucket>(BUCKET_COLLECTION);
  const attempts = connection.db!.collection<Attempt>(ATTEMPT_COLLECTION);

  function digest(kind: RateLimitKind, subject: string): string {
    return createHmac("sha256", key).update(JSON.stringify(["libraryos.rate-limit.v1", kind, subject])).digest("hex");
  }

  // Initialize/reset outside a transaction to avoid first-use unique-upsert races
  // inside it. Active windows remain unchanged; all time uses MongoDB $$NOW.
  async function ensure(kind: RateLimitKind, id: string): Promise<void> {
    const policy = RATE_LIMIT_POLICIES[kind];
    const expired = { $lte: [{ $ifNull: ["$expiresAt", new Date(0)] }, "$$NOW"] };
    try {
      await buckets.updateOne({ _id: id }, [{ $set: {
        kind, windowId: { $cond: [expired, new Types.ObjectId(), "$windowId"] },
        count: { $cond: [expired, 0, "$count"] }, admitted: { $cond: [expired, false, "$admitted"] },
        retryAfterSeconds: { $cond: [expired, policy.windowMs / 1000, "$retryAfterSeconds"] },
        expiresAt: { $cond: [expired, { $add: ["$$NOW", policy.windowMs] }, "$expiresAt"] },
        createdAt: { $ifNull: ["$createdAt", "$$NOW"] }, updatedAt: { $cond: [expired, "$$NOW", "$updatedAt"] },
      } }], { upsert: true, writeConcern: { w: "majority" }, timeoutMS: 5_000 });
    } catch (error) {
      if (!(error instanceof mongo.MongoServerError && error.code === 11000) || !await buckets.findOne({ _id: id }, { timeoutMS: 5_000 })) throw error;
    }
  }

  async function take(kind: RateLimitKind, id: string, session?: ClientSession): Promise<Bucket> {
    const expired = { $lte: ["$expiresAt", "$$NOW"] };
    const result = await buckets.findOneAndUpdate({ _id: id, kind }, [
      { $set: { windowId: { $cond: [expired, new Types.ObjectId(), "$windowId"] },
        count: { $cond: [expired, 0, "$count"] },
        expiresAt: { $cond: [expired, { $add: ["$$NOW", RATE_LIMIT_POLICIES[kind].windowMs] }, "$expiresAt"] } } },
      { $set: { admitted: { $lt: ["$count", RATE_LIMIT_POLICIES[kind].limit] } } },
      { $set: { count: { $cond: ["$admitted", { $add: ["$count", 1] }, "$count"] }, updatedAt: "$$NOW",
        retryAfterSeconds: { $max: [1, { $ceil: { $divide: [{ $subtract: ["$expiresAt", "$$NOW"] }, 1000] } }] } } },
    ], { returnDocument: "after", ...(session ? { session } : { writeConcern: { w: "majority" as const }, timeoutMS: 5_000 }) });
    if (!result) throw new Error("Limiter window unavailable.");
    return result;
  }

  async function consume(kind: RateLimitKind, subject: string): Promise<void> {
    const id = digest(kind, subject);
    await ensure(kind, id);
    const result = await take(kind, id);
    if (!result.admitted) throw new RateLimitError(result.retryAfterSeconds);
  }

  async function safe<T>(work: () => Promise<T>): Promise<T> {
    try { return await work(); } catch (error) {
      if (error instanceof RateLimitError) throw error;
      throw new ApplicationError("SERVICE_UNAVAILABLE");
    }
  }

  async function beginLogin(accountEmail: string, trustedIp: string): Promise<LoginPermit> {
    return safe(async () => {
      await consume("login.ip", normalizeTrustedIp(trustedIp));
      const id = digest("login.account", normalizeEmail(accountEmail));
      await ensure("login.account", id);
      const attemptId = new Types.ObjectId();
      const admission = await runTransaction(connection, async ({ session }) => {
        const bucket = await take("login.account", id, session);
        if (!bucket.admitted) return { admitted: false as const, retryAfterSeconds: bucket.retryAfterSeconds };
        await attempts.insertOne({ _id: attemptId, bucketKey: id, windowId: bucket.windowId, status: "pending",
          expiresAt: bucket.expiresAt, createdAt: bucket.updatedAt, updatedAt: bucket.updatedAt }, { session });
        return { admitted: true as const };
      });
      if (!admission.admitted) throw new RateLimitError(admission.retryAfterSeconds);

      async function complete(outcome: LoginOutcome): Promise<void> {
        return safe(async () => {
          if (outcome !== "success" && outcome !== "failure") throw new Error("Invalid login outcome.");
          await runTransaction(connection, async ({ session }) => {
            const attempt = await attempts.findOneAndUpdate({ _id: attemptId, status: "pending" },
              [{ $set: { status: outcome, updatedAt: "$$NOW" } }], { session, returnDocument: "after" });
            if (!attempt || outcome === "failure") return;
            // Late success can never release capacity in a replacement window.
            await buckets.updateOne({ _id: attempt.bucketKey, windowId: attempt.windowId, count: { $gt: 0 } },
              [{ $set: { count: { $subtract: ["$count", 1] }, updatedAt: "$$NOW" } }], { session });
          });
        });
      }
      return Object.freeze({ complete });
    });
  }

  async function checkRequest(action: "registration" | "recovery", accountEmail: string, trustedIp: string): Promise<void> {
    return safe(async () => {
      if (action !== "registration" && action !== "recovery") throw new Error("Unsupported limiter action.");
      await consume(`${action}.ip`, normalizeTrustedIp(trustedIp));
      await consume(`${action}.account`, normalizeEmail(accountEmail));
    });
  }

  return Object.freeze({ beginLogin, checkRequest });
}
