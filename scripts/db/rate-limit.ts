import type { Connection } from "mongoose";
import { rateLimitValidators, verifyRateLimitStorage } from "../../src/server/security/rate-limit-contract.ts";

export async function deployRateLimitStorage(connection: Connection): Promise<void> {
  if (!connection.db) throw new Error("An open database is required.");
  for (const [name, validator] of Object.entries(rateLimitValidators)) {
    if (await connection.db.listCollections({ name }).hasNext()) {
      if (await connection.db.collection(name).countDocuments({ $nor: [validator] }, { limit: 1 })) throw new Error("Existing limiter data requires migration.");
      await connection.db.command({ collMod: name, validator, validationLevel: "strict", validationAction: "error" });
    } else {
      await connection.db.createCollection(name, { validator, validationLevel: "strict", validationAction: "error" });
    }
    await connection.db.collection(name).createIndex({ expiresAt: 1 }, { name: "rate_limit_expiry", expireAfterSeconds: 0 });
  }
  await verifyRateLimitStorage(connection);
}
