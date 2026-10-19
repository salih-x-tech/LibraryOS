import type { Connection } from "mongoose";
import { userValidator, verifyUserIdentity } from "../../src/modules/auth/identity-storage.ts";
export { userValidator, verifyUserIdentity } from "../../src/modules/auth/identity-storage.ts";

// Explicit, separate identity provisioning. The Phase 2 CLI remains unchanged.
export async function deployUserIdentity(connection: Connection): Promise<void> {
  if (!connection.db) throw new Error("An open database is required.");
  if (await connection.db.listCollections({ name: "users" }).hasNext()) {
    if (await connection.db.collection("users").countDocuments({ $nor: [userValidator] }, { limit: 1 })) {
      throw new Error("Existing identity data requires migration.");
    }
    await connection.db.command({ collMod: "users", validator: userValidator, validationLevel: "strict", validationAction: "error" });
  } else {
    await connection.db.createCollection("users", { validator: userValidator, validationLevel: "strict", validationAction: "error" });
  }
  await connection.db.collection("users").createIndex({ normalizedEmail: 1 }, { name: "user_email_unique", unique: true });
  await verifyUserIdentity(connection);
}
