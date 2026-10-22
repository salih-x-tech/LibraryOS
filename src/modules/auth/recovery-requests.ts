import "server-only";
import { Types, type Connection } from "mongoose";
import type { createMongoRateLimiter } from "@/server/security/rate-limit";
import { runTransaction } from "@/server/db/transaction";
import { requestId } from "@/server/db/persistence";
import type { RequestContext } from "@/server/http/responses";
import { ApplicationError } from "@/server/http/errors";
import { verifyInfrastructure } from "@/server/db/storage-contract";
import { appendAudit } from "@/modules/audit/append";
import { verifyRecoveryRequests } from "./recovery-request-storage";
import { createRecoveryRequestCipher } from "./recovery-request-crypto";
import { normalizeEmail } from "./validation";
import type { ActionTokenPurpose } from "./action-token-format";

// Admission only: no user lookup, token issuance, SMTP connection or eligibility
// result. A durable intent is not a promise that a message was or will be sent.
export async function createRecoveryRequestQueue(connection: Connection,
  limiter: Pick<Awaited<ReturnType<typeof createMongoRateLimiter>>, "checkRequest">, secret: Uint8Array) {
  const cipher = createRecoveryRequestCipher(secret);
  try { await verifyInfrastructure(connection); await verifyRecoveryRequests(connection); }
  catch { throw new ApplicationError("SERVICE_UNAVAILABLE"); }
  const requests = connection.db!.collection("authRecoveryRequests");
  async function enqueue(purpose: ActionTokenPurpose, email: string, ip: string, context: RequestContext): Promise<void> {
    try {
      const correlation = requestId(context.requestId);
      const normalized = normalizeEmail(email);
      const sealed = cipher.seal(normalized, purpose, correlation);
      await limiter.checkRequest("recovery", normalized, ip);
      const identity = new Types.ObjectId();
      await runTransaction(connection, async (transaction) => {
        await requests.insertOne({ _id: identity, purpose, requestId: correlation, ...sealed, status: "pending", createdAt: new Date() }, { session: transaction.session });
        await appendAudit(connection, transaction, { scope: { kind: "global" }, actor: { systemIdentity: "authRecovery" },
          action: "auth.recoveryRequested", resourceType: "recoveryRequest", resourceId: identity.toHexString(), branchIds: [], requestId: correlation,
          changedFields: ["request"] });
      });
    } catch (error) {
      if (error instanceof ApplicationError) throw error;
      throw new ApplicationError("SERVICE_UNAVAILABLE");
    }
  }
  return Object.freeze({ enqueue });
}
