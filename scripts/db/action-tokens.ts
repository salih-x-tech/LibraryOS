import type { Connection } from "mongoose";
import { actionTokenValidator, actionTokenIndexes, verifyActionTokens } from "../../src/modules/auth/action-token-storage.ts";

// A future reviewed migration composes this; login deployment remains unchanged.
export async function deployActionTokens(connection: Connection): Promise<void> {
  if (!connection.db) throw new Error("An open database is required.");
  if (await connection.db.listCollections({ name: "authActionTokens" }).hasNext()) {
    if (await connection.db.collection("authActionTokens").countDocuments({ $nor: [actionTokenValidator] }, { limit: 1 })) throw new Error("Existing authentication tokens require migration.");
    await connection.db.command({ collMod: "authActionTokens", validator: actionTokenValidator, validationLevel: "strict", validationAction: "error" });
  } else {
    await connection.db.createCollection("authActionTokens", { validator: actionTokenValidator, validationLevel: "strict", validationAction: "error" });
  }
  await connection.db.collection("authActionTokens").createIndexes([...actionTokenIndexes]);
  await verifyActionTokens(connection);
}
