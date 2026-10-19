import "server-only";
import { randomBytes } from "node:crypto";
import type { Connection } from "mongoose";
import { appendAudit } from "@/modules/audit/append";
import { ApplicationError } from "@/server/http/errors";
import type { RequestContext } from "@/server/http/responses";
import { requestId } from "@/server/db/persistence";
import { runTransaction } from "@/server/db/transaction";
import type { createMongoRateLimiter } from "@/server/security/rate-limit";
import { getUserModel } from "./user-model";
import { getSessionModel } from "./session-model";
import { hashPassword, verifyPassword } from "./passwords";
import { isSupportedPasswordHash } from "./password-format";
import { validateLoginInput } from "./validation";
import { createSessionService } from "./session-service";
import { hashSessionToken } from "./sessions";
import { APPROVED_SESSION_POLICY, SESSION_LIFETIME_MS } from "./session-policy";

export type AuthLimiter = Pick<Awaited<ReturnType<typeof createMongoRateLimiter>>, "beginLogin">;
export type LoginResult = Readonly<{
  // Server-only transport data: routes must set the cookie and project user only.
  token: string; expiresAt: Date; user: Readonly<{ id: string; email: string }>;
}>;

export async function createAuthService(connection: Connection, limiter: AuthLimiter) {
  if (!limiter || typeof limiter.beginLogin !== "function") throw new Error("A shared authentication limiter is required.");
  // Cache this service per process/connection; never generate a dummy per request.
  const dummyHash = await hashPassword(randomBytes(32).toString("hex"));
  const users = getUserModel(connection);
  const sessions = getSessionModel(connection);
  const sessionService = createSessionService(connection, APPROVED_SESSION_POLICY);

  async function safe<T>(work: () => Promise<T>): Promise<T> {
    try { return await work(); } catch (error) {
      if (error instanceof ApplicationError) throw error;
      throw new ApplicationError("SERVICE_UNAVAILABLE");
    }
  }

  async function login(body: unknown, trustedIp: string, context: RequestContext): Promise<LoginResult> {
    return safe(async () => {
      const input = validateLoginInput(body);
      const correlation = requestId(context.requestId);
      const permit = await limiter.beginLogin(input.email, trustedIp);
      let completed = false;
      try {
        const user = await users.findOne({ normalizedEmail: input.email }).select("+passwordHash").lean().exec();
        const supported = user !== null && isSupportedPasswordHash(user.passwordHash);
        const verification = await verifyPassword(input.password, supported ? user.passwordHash : dummyHash);
        const eligible = supported && verification.verified && user.status === "active" && user.verifiedAt instanceof Date;
        await permit.complete(eligible ? "success" : "failure");
        completed = true;
        if (!eligible || !user) throw new ApplicationError("UNAUTHENTICATED");
        const identity = { userId: user._id.toHexString(), sessionVersion: user.sessionVersion, authorizationVersion: user.authorizationVersion };
        return runTransaction(connection, async (transaction) => {
          // A reset/state change after verification must invalidate this snapshot.
          const unchanged = await users.exists({ _id: user._id, passwordHash: user.passwordHash,
            sessionVersion: identity.sessionVersion, authorizationVersion: identity.authorizationVersion,
            status: "active", verifiedAt: { $type: "date" },
          }).session(transaction.session);
          if (!unchanged) throw new ApplicationError("UNAUTHENTICATED");
          const issued = await sessionService.issue(transaction, identity, new Date(Date.now() + SESSION_LIFETIME_MS));
          await appendAudit(connection, transaction, {
            scope: { kind: "global" }, actor: { userId: identity.userId }, action: "auth.login",
            resourceType: "sessionFamily", resourceId: issued.familyId, branchIds: [], requestId: correlation,
            changedFields: ["tokenHash", "expiresAt"],
          });
          return { token: issued.token, expiresAt: issued.expiresAt, user: { id: identity.userId, email: user.normalizedEmail } };
        });
      } catch (error) {
        // On a crash/store failure the conservative reservation may remain until
        // expiry. Never report successful login if finalization is unavailable.
        if (!completed) await permit.complete("failure");
        throw error;
      }
    });
  }

  async function logout(token: string, context: RequestContext): Promise<void> {
    return safe(async () => {
      const correlation = requestId(context.requestId);
      const tokenHash = hashSessionToken(token);
      if (!tokenHash) return;
      await runTransaction(connection, async (transaction) => {
        const record = await sessions.findOne({ tokenHash }).select("userId familyId").session(transaction.session).lean().exec();
        if (!record) return;
        const live = await sessions.exists({ userId: record.userId, familyId: record.familyId, revokedAt: { $exists: false } }).session(transaction.session);
        if (!live) return;
        await sessionService.revoke(transaction, token);
        await appendAudit(connection, transaction, {
          scope: { kind: "global" }, actor: { userId: record.userId.toHexString() }, action: "auth.logout",
          resourceType: "sessionFamily", resourceId: record.familyId.toHexString(), branchIds: [], requestId: correlation,
          changedFields: ["revokedAt"],
        });
      });
    });
  }

  return Object.freeze({ login, logout, resolveSession: sessionService.resolve });
}
