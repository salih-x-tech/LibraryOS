import type { Connection } from "mongoose";
import { recoveryRequestValidator, recoveryRequestIndexes, verifyRecoveryRequests } from "../../src/modules/auth/recovery-request-storage.ts";

export async function deployRecoveryRequests(connection: Connection): Promise<void> {
  if (!connection.db) throw new Error("An open database is required.");
  if (await connection.db.listCollections({ name: "authRecoveryRequests" }).hasNext()) {
    if (await connection.db.collection("authRecoveryRequests").countDocuments({ $nor: [recoveryRequestValidator] }, { limit: 1 })) throw new Error("Existing recovery requests require migration.");
    await connection.db.command({ collMod: "authRecoveryRequests", validator: recoveryRequestValidator, validationLevel: "strict", validationAction: "error" });
  } else await connection.db.createCollection("authRecoveryRequests", { validator: recoveryRequestValidator, validationLevel: "strict", validationAction: "error" });
  await connection.db.collection("authRecoveryRequests").createIndexes([...recoveryRequestIndexes]);
  await verifyRecoveryRequests(connection);
}
