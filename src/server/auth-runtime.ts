import "server-only";
import { getDatabaseConnection } from "./db/connection";
import { verifyInfrastructure } from "./db/storage-contract";
import { readLocalAuthConfiguration } from "./auth-config";
import { verifyUserIdentity } from "@/modules/auth/identity-storage";
import { verifySessions } from "@/modules/auth/session-storage";
import { createAuthService } from "@/modules/auth/service";
import { createMongoRateLimiter } from "./security/rate-limit";
import { ApplicationError } from "./http/errors";

let pending: Promise<Awaited<ReturnType<typeof createAuthService>>> | undefined;

export async function getAuthService() {
  try {
    const config = readLocalAuthConfiguration();
    pending ??= (async () => {
      const connection = await getDatabaseConnection();
      await verifyInfrastructure(connection);
      await verifyUserIdentity(connection);
      await verifySessions(connection);
      const limiter = await createMongoRateLimiter(connection, config.limiterKey);
      return createAuthService(connection, limiter);
    })().catch((error: unknown) => { pending = undefined; throw error; });
    return await pending;
  } catch {
    throw new ApplicationError("SERVICE_UNAVAILABLE");
  }
}
