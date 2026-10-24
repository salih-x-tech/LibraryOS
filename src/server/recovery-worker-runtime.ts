import "server-only";
import { readLocalAuthConfiguration } from "./auth-config";
import { getLocalRecoveryService } from "./recovery-runtime";
import { getDatabaseConnection } from "./db/connection";
import { createGmailRecoveryDelivery } from "@/modules/notifications/gmail-recovery";
import { createRecoveryDeliveryWorker } from "@/modules/auth/recovery-delivery-worker";
import { createRecoveryRequestLifecycle } from "@/modules/auth/recovery-request-lifecycle";
import { readRecoveryQueueKey } from "@/modules/auth/recovery-request-crypto";
import { ApplicationError } from "./http/errors";

let pending: Promise<{
  worker: Awaited<ReturnType<typeof createRecoveryDeliveryWorker>>;
  lifecycle: Awaited<ReturnType<typeof createRecoveryRequestLifecycle>>;
}> | undefined;

// Internal, explicitly invoked one-job runtime. No HTTP entry point, timer or
// polling loop. Construction checks prerequisites but opens no SMTP connection.
export async function getLocalRecoveryWorker() {
  try {
    readLocalAuthConfiguration();
    if (process.env.AUTH_RECOVERY_WORKER !== "1") throw new Error();
    const key = readRecoveryQueueKey();
    pending ??= (async () => {
      const issuer = await getLocalRecoveryService();
      const connection = await getDatabaseConnection();
      const delivery = createGmailRecoveryDelivery();
      try {
        const worker = await createRecoveryDeliveryWorker(connection, key, issuer, delivery);
        const lifecycle = await createRecoveryRequestLifecycle(connection);
        return Object.freeze({ worker, lifecycle });
      } catch (error) { delivery.close(); throw error; }
    })().catch((error: unknown) => { pending = undefined; throw error; });
    return await pending;
  } catch { throw new ApplicationError("SERVICE_UNAVAILABLE"); }
}
