import "server-only";
import { readLocalAuthConfiguration } from "./auth-config";
import { getDatabaseConnection } from "./db/connection";
import { createMongoRateLimiter } from "./security/rate-limit";
import { ApplicationError } from "./http/errors";
import { readRecoveryQueueKey } from "@/modules/auth/recovery-request-crypto";
import { createRecoveryRequestQueue } from "@/modules/auth/recovery-requests";

let pending: Promise<Awaited<ReturnType<typeof createRecoveryRequestQueue>>> | undefined;

// Admission has no dependency on identity lookup, blocklists or mail providers.
export async function getLocalRecoveryRequestQueue() {
  try {
    const config = readLocalAuthConfiguration();
    const key = readRecoveryQueueKey();
    pending ??= (async () => {
      const connection = await getDatabaseConnection();
      const limiter = await createMongoRateLimiter(connection, config.limiterKey);
      return createRecoveryRequestQueue(connection, limiter, key);
    })().catch((error: unknown) => { pending = undefined; throw error; });
    return await pending;
  } catch { throw new ApplicationError("SERVICE_UNAVAILABLE"); }
}
