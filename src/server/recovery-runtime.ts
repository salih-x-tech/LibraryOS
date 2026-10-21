import "server-only";
import { readLocalAuthConfiguration } from "./auth-config";
import { readGmailConfiguration } from "./mail-config";
import { getDatabaseConnection } from "./db/connection";
import { verifyInfrastructure } from "./db/storage-contract";
import { verifyUserIdentity } from "@/modules/auth/identity-storage";
import { verifySessions } from "@/modules/auth/session-storage";
import { loadPasswordBlocklist } from "@/modules/auth/password-blocklist";
import { createLocalRecoveryService } from "@/modules/auth/recovery-service";
import { createGmailRecoveryDelivery } from "@/modules/notifications/gmail-recovery";
import { createMongoRateLimiter } from "./security/rate-limit";
import { ApplicationError } from "./http/errors";

let pending: Promise<Awaited<ReturnType<typeof createLocalRecoveryService>>> | undefined;

// Deliberately not imported by a Route Handler. Construction validates local
// config/storage but never authenticates to Gmail or sends email on startup.
export async function getLocalRecoveryService() {
  try {
    const configuration = readLocalAuthConfiguration();
    pending ??= (async () => {
      readGmailConfiguration();
      const blocklist = loadPasswordBlocklist();
      const connection = await getDatabaseConnection();
      await verifyInfrastructure(connection);
      await verifyUserIdentity(connection);
      await verifySessions(connection);
      const limiter = await createMongoRateLimiter(connection, configuration.limiterKey);
      const delivery = createGmailRecoveryDelivery();
      try { return await createLocalRecoveryService(connection, limiter, delivery, blocklist.validate); }
      catch (error) { delivery.close(); throw error; }
    })().catch((error: unknown) => { pending = undefined; throw error; });
    return await pending;
  } catch { throw new ApplicationError("SERVICE_UNAVAILABLE"); }
}
