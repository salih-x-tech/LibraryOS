import "server-only";
import type { Connection } from "mongoose";
import { ApplicationError } from "@/server/http/errors";
import { runTransaction } from "@/server/db/transaction";
import { requestId } from "@/server/db/persistence";
import type { RequestContext } from "@/server/http/responses";
import { appendAudit } from "@/modules/audit/append";
import type { createMongoRateLimiter } from "@/server/security/rate-limit";
import { verifyActionTokens } from "./action-token-storage";
import { createActionTokenStore } from "./action-tokens";
import { getActionTokenModel } from "./action-token-model";
import { getUserModel } from "./user-model";
import { getSessionModel } from "./session-model";
import { hashActionToken, type ActionTokenPurpose } from "./action-token-format";
import { normalizeEmail } from "./validation";
import { hashPassword, verifyPassword } from "./passwords";
import { createNewPasswordValidator } from "./new-password";
import { RESET_LIFETIME_MS, VERIFICATION_LIFETIME_MS } from "./recovery-policy";

type Limiter = Pick<Awaited<ReturnType<typeof createMongoRateLimiter>>, "checkRequest" | "checkCompletion">;
export type TestRecoveryDelivery = Readonly<{
  kind: "synthetic-memory";
  ready: () => Promise<void>;
  send: (message: Readonly<{ email: string; purpose: ActionTokenPurpose; url: string }>) => Promise<void>;
}>;

// Intentionally unavailable to real-user runtime or public endpoints. The
// adapter is injected by owned synthetic fixtures, never serialized or logged.
export async function createTestRecoveryService(connection: Connection, limiter: Limiter, delivery: TestRecoveryDelivery,
  configuration: Readonly<{ origin: string; blocklist: readonly string[] }>) {
  if (process.env.NODE_ENV !== "test" || delivery.kind !== "synthetic-memory"
    || connection.host !== "127.0.0.1" || !connection.name.startsWith("libraryos_test_")) throw new ApplicationError("SERVICE_UNAVAILABLE");
  const origin = new URL(configuration.origin);
  if (origin.protocol !== "https:" || origin.hostname !== "127.0.0.1" || origin.origin !== configuration.origin) throw new ApplicationError("SERVICE_UNAVAILABLE");
  await verifyActionTokens(connection);
  const validatePassword = createNewPasswordValidator(configuration.blocklist);
  const users = getUserModel(connection);
  const tokens = getActionTokenModel(connection);
  const sessions = getSessionModel(connection);
  const store = createActionTokenStore(connection);
  const eligibility = (purpose: ActionTokenPurpose) => purpose === "verify-email"
    ? { status: "pending_verification", verifiedAt: { $exists: false } } as const
    : { status: "active", verifiedAt: { $type: "date" } } as const;
  const invalid = () => new ApplicationError("BAD_REQUEST");
  async function safe<T>(work: () => Promise<T>) {
    try { return await work(); } catch (error) {
      if (error instanceof ApplicationError) throw error;
      throw new ApplicationError("SERVICE_UNAVAILABLE");
    }
  }

  async function request(purpose: ActionTokenPurpose, email: string, ip: string, context: RequestContext): Promise<void> {
    return safe(async () => {
      // This also rejects invalid purposes without consulting account storage.
      hashActionToken(purpose, "");
      const normalized = normalizeEmail(email);
      const correlation = requestId(context.requestId);
      await limiter.checkRequest("recovery", normalized, ip);
      await delivery.ready(); // Same readiness check for unknown/ineligible email.
      const message = await runTransaction(connection, async (transaction) => {
        const user = await users.findOneAndUpdate({ normalizedEmail: normalized, ...eligibility(purpose), operationFence: { $lt: Number.MAX_SAFE_INTEGER } },
          { $inc: { operationFence: 1 } }, { session: transaction.session, returnDocument: "after", runValidators: true }).lean().exec();
        if (!user) return null;
        // Touching the shared user guard serializes reissue with reset/login.
        await tokens.updateMany({ userId: user._id, purpose, consumedAt: { $exists: false } },
          { $currentDate: { consumedAt: true } }, { session: transaction.session }).exec();
        const issued = await store.issue(transaction, { userId: user._id.toHexString(), sessionVersion: user.sessionVersion }, purpose,
          new Date(Date.now() + (purpose === "verify-email" ? VERIFICATION_LIFETIME_MS : RESET_LIFETIME_MS)));
        await appendAudit(connection, transaction, { scope: { kind: "global" }, actor: { systemIdentity: "authRecovery" },
          action: "auth.tokenRequested", resourceType: "user", resourceId: user._id.toHexString(), branchIds: [], requestId: correlation,
          changedFields: ["actionToken"] });
        return { email: normalized, purpose, url: `${origin.origin}/${purpose}#token=${issued.token}` };
      });
      // Never deliver from a retriable transaction callback. A post-commit send
      // failure is surfaced; a fresh request may reissue, subject to shared limits.
      if (message) await delivery.send(message);
    });
  }

  async function complete(purpose: ActionTokenPurpose, token: string, ip: string, context: RequestContext, newPassword?: unknown): Promise<void> {
    return safe(async () => {
      const digest = hashActionToken(purpose, token);
      const correlation = requestId(context.requestId);
      await limiter.checkCompletion(purpose, ip);
      if (!digest) throw invalid();
      const snapshot = await tokens.findOne({ tokenHash: digest, purpose, consumedAt: { $exists: false }, $expr: { $gt: ["$expiresAt", "$$NOW"] } }).lean().exec();
      if (!snapshot) throw invalid();
      const user = await users.findOne({ _id: snapshot.userId, sessionVersion: snapshot.sessionVersion, ...eligibility(purpose) }).select("+passwordHash").lean().exec();
      if (!user) throw invalid();
      let passwordHash: string | undefined;
      if (purpose === "reset-password") {
        const candidate = validatePassword(newPassword, user.normalizedEmail);
        if ((await verifyPassword(candidate, user.passwordHash)).verified) throw invalid();
        passwordHash = await hashPassword(candidate);
      }
      await runTransaction(connection, async (transaction) => {
        const changed = await users.updateOne({ _id: user._id,
          passwordHash: user.passwordHash, authorizationVersion: user.authorizationVersion, ...eligibility(purpose),
          operationFence: { $lt: Number.MAX_SAFE_INTEGER }, sessionVersion: { $eq: snapshot.sessionVersion, $lt: Number.MAX_SAFE_INTEGER } },
        { $inc: { operationFence: 1, sessionVersion: 1 }, $set: purpose === "verify-email"
          ? { status: "active", verifiedAt: new Date() } : { passwordHash } }, { session: transaction.session, runValidators: true }).exec();
        if (changed.modifiedCount !== 1) throw invalid();
        if (!await store.consume(transaction, purpose, token)) throw invalid();
        await tokens.updateMany({ userId: user._id, consumedAt: { $exists: false } }, { $currentDate: { consumedAt: true } }, { session: transaction.session }).exec();
        await sessions.updateMany({ userId: user._id, revokedAt: { $exists: false } }, { $set: { revokedAt: new Date() } }, { session: transaction.session }).exec();
        await appendAudit(connection, transaction, { scope: { kind: "global" }, actor: { userId: user._id.toHexString() },
          action: purpose === "verify-email" ? "auth.emailVerified" : "auth.passwordReset", resourceType: "user", resourceId: user._id.toHexString(),
          branchIds: [], requestId: correlation, changedFields: purpose === "verify-email" ? ["status", "verifiedAt", "sessionVersion"] : ["passwordHash", "sessionVersion"] });
      });
    });
  }
  return Object.freeze({ request, complete });
}
