import "server-only";
import type { Connection } from "mongoose";
import { ApplicationError } from "@/server/http/errors";
import { runTransaction } from "@/server/db/transaction";
import type { RequestContext } from "@/server/http/responses";
import { requestId } from "@/server/db/persistence";
import { createRecoveryRequestLifecycle } from "./recovery-request-lifecycle";
import { createRecoveryRequestCipher } from "./recovery-request-crypto";
import type { createLocalRecoveryService, TestRecoveryDelivery } from "./recovery-service";

type Issuer = Pick<Awaited<ReturnType<typeof createLocalRecoveryService>>, "issueForDelivery">;
type Delivery = Pick<TestRecoveryDelivery, "ready" | "send">;

// Explicit one-job execution, no polling, background scheduling or automatic
// retries. The caller owns its configured provider. Construction sends nothing.
export async function createRecoveryDeliveryWorker(connection: Connection, secret: Uint8Array, issuer: Issuer, delivery: Delivery) {
  const lifecycle = await createRecoveryRequestLifecycle(connection);
  const cipher = createRecoveryRequestCipher(secret);
  async function processOne(context: RequestContext): Promise<Readonly<{ processed: boolean; finalized: boolean }>> {
    const job = await lifecycle.claim(context);
    if (!job) return Object.freeze({ processed: false, finalized: false });
    let sendStarted = false;
    try {
      const email = cipher.open(job, job.purpose, job.requestId);
      await delivery.ready();
      const message = await runTransaction(connection, async (transaction) => {
        await lifecycle.guard(transaction, job.id, job.leaseToken);
        return issuer.issueForDelivery(transaction, job.purpose, email, { requestId: requestId(job.requestId) });
      });
      if (!await lifecycle.isLive(job.id, job.leaseToken)) throw new ApplicationError("CONFLICT");
      if (message) {
        // A paused process can still resume after this check. The no-reclaim
        // policy avoids a second worker blindly repeating an ambiguous send.
        sendStarted = true;
        await delivery.send(message);
      }
      const finalized = await lifecycle.finalize(job.id, job.leaseToken, "completed", context);
      return Object.freeze({ processed: true, finalized });
    } catch {
      // Never retry SMTP or requeue. Unknown send/acknowledgment outcomes remain
      // uncertain; failures proven before send use failed. Expired leases cannot
      // finalize here and await the explicit lifecycle expiry operation.
      try {
        const finalized = await lifecycle.finalize(job.id, job.leaseToken, sendStarted ? "uncertain" : "failed", context);
        return Object.freeze({ processed: true, finalized });
      } catch { throw new ApplicationError("SERVICE_UNAVAILABLE"); }
    }
  }
  return Object.freeze({ processOne });
}
