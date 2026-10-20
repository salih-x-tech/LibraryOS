import type { Connection } from "mongoose";
import { deployUserIdentity, verifyUserIdentity } from "./identity.ts";
import { deploySessions, verifySessions } from "./sessions.ts";
import { deployRateLimitStorage } from "./rate-limit.ts";
import { verifyRateLimitStorage } from "../../src/server/security/rate-limit-contract.ts";
import { verifyInfrastructure } from "./indexes.ts";

// Audit storage is a prerequisite; auth deployment never silently provisions it.
export async function verifyAuthStorage(connection: Connection): Promise<void> {
  await verifyInfrastructure(connection);
  await verifyUserIdentity(connection);
  await verifySessions(connection);
  await verifyRateLimitStorage(connection);
}

export async function deployAuthStorage(connection: Connection): Promise<void> {
  await verifyInfrastructure(connection);
  await deployUserIdentity(connection);
  await deploySessions(connection);
  await deployRateLimitStorage(connection);
  await verifyAuthStorage(connection);
}
