import type { Connection } from "mongoose";
import { validators } from "../../src/server/db/validators.ts";
import { indexes, verifyInfrastructure } from "../../src/server/db/storage-contract.ts";
export { indexes, verifyInfrastructure } from "../../src/server/db/storage-contract.ts";

// Explicit deployment only. No syncIndexes, collection drops or startup hooks.
export async function deployInfrastructure(connection: Connection): Promise<void> {
  if (!connection.db) throw new Error("An open database is required.");
  for (const [name, validator] of Object.entries(validators)) {
    const exists = await connection.db.listCollections({ name }).hasNext();
    if (exists) {
      if (await connection.db.collection(name).countDocuments({ $nor: [validator] }, { limit: 1 })) {
        throw new Error("Existing infrastructure data violates the deployment specification. Migration is required.");
      }
      await connection.db.command({ collMod: name, validator, validationLevel: "strict", validationAction: "error" });
    } else {
      await connection.db.createCollection(name, { validator, validationLevel: "strict", validationAction: "error" });
    }
    await connection.db.collection(name).createIndexes([...(indexes[name] ?? [])]);
  }
  await verifyInfrastructure(connection);
}
