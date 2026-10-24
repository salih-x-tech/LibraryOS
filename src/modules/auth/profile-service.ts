import "server-only";
import type { Connection } from "mongoose";
import { createSessionService } from "./session-service";
import { APPROVED_SESSION_POLICY, SESSION_IDLE_TIMEOUT_MS } from "./session-policy";
import { getUserModel } from "./user-model";
import { getSessionModel } from "./session-model";
import { hashSessionToken } from "./sessions";
import { ApplicationError, FieldValidationError } from "@/server/http/errors";
import { runTransaction } from "@/server/db/transaction";
import { appendAudit } from "@/modules/audit/append";
import type { RequestContext } from "@/server/http/responses";

export function validateProfileInput(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).length !== 1 || !Object.hasOwn(value, "displayName")) throw new ApplicationError("BAD_REQUEST");
  const name = (value as Record<string, unknown>).displayName;
  if (typeof name !== "string" || !name.isWellFormed() || name.length > 100
    || /[\x00-\x1f\x7f]/.test(name)) throw new FieldValidationError(["displayName"], [{ field: "displayName", code: "INVALID" }]);
  return name.trim();
}

export function createProfileService(connection: Connection) {
  const sessions = createSessionService(connection, APPROVED_SESSION_POLICY);
  const users = getUserModel(connection);
  async function read(token: string) {
    const principal = await sessions.resolve(token);
    if (!principal) throw new ApplicationError("UNAUTHENTICATED");
    const user = await users.findOne({ _id: principal.userId, sessionVersion: principal.sessionVersion,
      authorizationVersion: principal.authorizationVersion, status: "active", verifiedAt: { $type: "date" } })
      .select("normalizedEmail displayName").lean().exec();
    if (!user) throw new ApplicationError("UNAUTHENTICATED");
    return { principal, user: { id: principal.userId, email: user.normalizedEmail, displayName: user.displayName ?? "" } };
  }
  async function update(token: string, value: unknown, context: RequestContext) {
    const displayName = validateProfileInput(value);
    const { principal } = await read(token);
    return runTransaction(connection, async (transaction) => {
      // Write the session and user guards to serialize against logout/reset.
      const session = await getSessionModel(connection).updateOne({ _id: principal.sessionId, tokenHash: hashSessionToken(token),
        revokedAt: { $exists: false }, expiresAt: { $gt: new Date() },
        lastSeenAt: { $gt: new Date(Date.now() - SESSION_IDLE_TIMEOUT_MS) } },
      { $currentDate: { lastSeenAt: true } }, { session: transaction.session }).exec();
      if (session.matchedCount !== 1) throw new ApplicationError("UNAUTHENTICATED");
      const user = await users.findOneAndUpdate({ _id: principal.userId, sessionVersion: principal.sessionVersion,
        authorizationVersion: principal.authorizationVersion, status: "active", verifiedAt: { $type: "date" },
        operationFence: { $lt: Number.MAX_SAFE_INTEGER } },
      { $set: { displayName }, $inc: { operationFence: 1 } }, { session: transaction.session, returnDocument: "after", runValidators: true })
        .select("normalizedEmail displayName").lean().exec();
      if (!user) throw new ApplicationError("UNAUTHENTICATED");
      await appendAudit(connection, transaction, { scope: { kind: "global" }, actor: { userId: principal.userId },
        action: "auth.profileUpdated", resourceType: "user", resourceId: principal.userId, branchIds: [],
        requestId: context.requestId, changedFields: ["displayName"] });
      return { id: principal.userId, email: user.normalizedEmail, displayName: user.displayName ?? "" };
    });
  }
  return Object.freeze({ read, update });
}
