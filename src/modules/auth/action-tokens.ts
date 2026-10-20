import "server-only";
import type { Connection } from "mongoose";
import { identifier, requireTransaction } from "@/server/db/persistence";
import type { TransactionContext } from "@/server/db/transaction";
import { getActionTokenModel } from "./action-token-model";
import { createActionToken, hashActionToken, type ActionTokenPurpose } from "./action-token-format";

// Internal persistence primitives, not account authorization. The eventual
// use case must enforce eligibility/version fences and commit account changes,
// token consumption, session invalidation and audit in the same transaction.
export function createActionTokenStore(connection: Connection) {
  const tokens = getActionTokenModel(connection);

  async function issue(context: TransactionContext, identity: Readonly<{ userId: string; sessionVersion: number }>, purpose: ActionTokenPurpose, expiresAt: Date) {
    requireTransaction(context);
    const userId = identifier(identity.userId);
    if (!Number.isSafeInteger(identity.sessionVersion) || identity.sessionVersion < 0
      || !(expiresAt instanceof Date) || !Number.isFinite(expiresAt.getTime()) || expiresAt.getTime() <= Date.now()) throw new Error("Explicit valid token identity and future expiry are required.");
    const credential = createActionToken(purpose);
    await tokens.create([{ userId, sessionVersion: identity.sessionVersion, purpose, tokenHash: credential.tokenHash, expiresAt }], { session: context.session });
    return Object.freeze({ token: credential.token, expiresAt: new Date(expiresAt.getTime()) });
  }

  async function consume(context: TransactionContext, purpose: ActionTokenPurpose, token: string) {
    requireTransaction(context);
    const tokenHash = hashActionToken(purpose, token);
    if (!tokenHash) return null;
    // Expiry is enforced with database time, independently of asynchronous TTL.
    const record = await tokens.findOneAndUpdate({ tokenHash, purpose, consumedAt: { $exists: false },
      $expr: { $gt: ["$expiresAt", "$$NOW"] },
    }, { $currentDate: { consumedAt: true, updatedAt: true } }, { session: context.session, returnDocument: "after", timestamps: false })
      .select("userId sessionVersion").lean().exec();
    return record ? Object.freeze({ userId: record.userId.toHexString(), sessionVersion: record.sessionVersion }) : null;
  }

  return Object.freeze({ issue, consume });
}
