import "server-only";
import type { Connection } from "mongoose";
import { ApplicationError } from "@/server/http/errors";
import { identifier, requireTransaction } from "@/server/db/persistence";
import type { TransactionContext } from "@/server/db/transaction";
import { getUserModel } from "./user-model";
import { getSessionModel } from "./session-model";
import { createSessionCredential, hashSessionToken } from "./sessions";

export type SessionPolicy = Readonly<{
  allowedUserStatuses: readonly string[];
  requireVerifiedEmail: boolean;
}>;
export type SessionIdentity = Readonly<{ userId: string; sessionVersion: number; authorizationVersion: number }>;
export type SessionPrincipal = SessionIdentity & Readonly<{ sessionId: string }>;

function validVersion(value: number): boolean { return Number.isSafeInteger(value) && value >= 0; }

function expiry(value: Date): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime()) || value.getTime() <= Date.now()) {
    throw new Error("An explicit future session expiry is required.");
  }
  return new Date(value.getTime());
}

export function createSessionService(connection: Connection, policy: SessionPolicy) {
  if (!policy || typeof policy.requireVerifiedEmail !== "boolean" || !Array.isArray(policy.allowedUserStatuses)
    || policy.allowedUserStatuses.length < 1 || policy.allowedUserStatuses.length > 20
    || policy.allowedUserStatuses.some((status) => typeof status !== "string" || !/^[a-z][a-z0-9_]{0,39}$/.test(status))) {
    throw new Error("An explicit session authorization policy is required.");
  }
  const statuses = [...policy.allowedUserStatuses];
  const verifiedRequired = policy.requireVerifiedEmail;
  const users = getUserModel(connection);
  const sessions = getSessionModel(connection);

  function userPredicate(identity: SessionIdentity) {
    if (!validVersion(identity.sessionVersion) || !validVersion(identity.authorizationVersion)) throw new ApplicationError("UNAUTHENTICATED");
    return {
      _id: identifier(identity.userId), sessionVersion: identity.sessionVersion,
      authorizationVersion: identity.authorizationVersion, status: { $in: statuses },
      ...(verifiedRequired ? { verifiedAt: { $type: "date" as const } } : {}),
    };
  }

  async function touchUser(context: TransactionContext, identity: SessionIdentity): Promise<void> {
    const result = await users.updateOne({ ...userPredicate(identity), operationFence: { $lt: Number.MAX_SAFE_INTEGER } },
      { $inc: { operationFence: 1 } }, { session: context.session, runValidators: true }).exec();
    if (result.modifiedCount !== 1) throw new ApplicationError("UNAUTHENTICATED");
  }

  async function resolve(token: string): Promise<SessionPrincipal | null> {
    const tokenHash = hashSessionToken(token);
    if (!tokenHash) return null;
    try {
      const record = await sessions.findOne({ tokenHash, revokedAt: { $exists: false }, expiresAt: { $gt: new Date() } }).lean().exec();
      if (!record) return null;
      const user = await users.findOne({
        _id: record.userId, sessionVersion: record.sessionVersion, status: { $in: statuses },
        ...(verifiedRequired ? { verifiedAt: { $type: "date" } } : {}),
      }).select("_id sessionVersion authorizationVersion").lean().exec();
      if (!user || record.expiresAt.getTime() <= Date.now()) return null;
      return Object.freeze({ userId: user._id.toHexString(), sessionId: record._id.toHexString(),
        sessionVersion: user.sessionVersion, authorizationVersion: user.authorizationVersion });
    } catch {
      throw new ApplicationError("SERVICE_UNAVAILABLE");
    }
  }

  async function insert(context: TransactionContext, identity: SessionIdentity, expiresAt: Date) {
    const deadline = expiry(expiresAt);
    const credential = createSessionCredential();
    await sessions.create([{
      tokenHash: credential.tokenHash, userId: identifier(identity.userId), sessionVersion: identity.sessionVersion, expiresAt: deadline,
    }], { session: context.session });
    return { token: credential.token, expiresAt: deadline };
  }

  // Only call after credentials are verified. Identity/version inputs come from
  // the server's verified user read, never request fields or a previous cookie.
  async function issue(context: TransactionContext, identity: SessionIdentity, expiresAt: Date) {
    requireTransaction(context);
    expiry(expiresAt);
    const asserted = { userId: identity.userId, sessionVersion: identity.sessionVersion, authorizationVersion: identity.authorizationVersion };
    await touchUser(context, asserted);
    return insert(context, asserted, expiresAt);
  }

  async function rotate(context: TransactionContext, token: string, expiresAt: Date) {
    requireTransaction(context);
    expiry(expiresAt);
    const tokenHash = hashSessionToken(token);
    if (!tokenHash) throw new ApplicationError("UNAUTHENTICATED");
    const previous = await sessions.findOne({ tokenHash, revokedAt: { $exists: false }, expiresAt: { $gt: new Date() } }).session(context.session).lean().exec();
    if (!previous) throw new ApplicationError("UNAUTHENTICATED");
    const user = await users.findOne({ _id: previous.userId }).select("_id sessionVersion authorizationVersion").session(context.session).lean().exec();
    if (!user || user.sessionVersion !== previous.sessionVersion) throw new ApplicationError("UNAUTHENTICATED");
    const identity = { userId: user._id.toHexString(), sessionVersion: user.sessionVersion, authorizationVersion: user.authorizationVersion };
    await touchUser(context, identity);
    const changed = await sessions.updateOne({ _id: previous._id, revokedAt: { $exists: false }, expiresAt: { $gt: new Date() } },
      { $set: { revokedAt: new Date() } }, { session: context.session, runValidators: true }).exec();
    if (changed.modifiedCount !== 1) throw new ApplicationError("UNAUTHENTICATED");
    return insert(context, identity, expiresAt);
  }

  async function revoke(context: TransactionContext, token: string): Promise<void> {
    requireTransaction(context);
    const tokenHash = hashSessionToken(token);
    if (!tokenHash) return;
    // The same record is conditionally written by rotation, serializing logout.
    await sessions.updateOne({ tokenHash, revokedAt: { $exists: false } }, { $set: { revokedAt: new Date() } },
      { session: context.session, runValidators: true }).exec();
  }

  async function revokeAll(context: TransactionContext, identity: SessionIdentity): Promise<void> {
    requireTransaction(context);
    const asserted = { userId: identity.userId, sessionVersion: identity.sessionVersion, authorizationVersion: identity.authorizationVersion };
    if (asserted.sessionVersion >= Number.MAX_SAFE_INTEGER) throw new ApplicationError("UNAUTHENTICATED");
    const changed = await users.updateOne({ ...userPredicate(asserted), operationFence: { $lt: Number.MAX_SAFE_INTEGER } },
      { $inc: { sessionVersion: 1, operationFence: 1 } }, { session: context.session, runValidators: true }).exec();
    if (changed.modifiedCount !== 1) throw new ApplicationError("UNAUTHENTICATED");
    await sessions.updateMany({ userId: identifier(asserted.userId), revokedAt: { $exists: false } },
      { $set: { revokedAt: new Date() } }, { session: context.session, runValidators: true }).exec();
  }

  return Object.freeze({ resolve, issue, rotate, revoke, revokeAll });
}
