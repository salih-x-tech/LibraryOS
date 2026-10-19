import type { Connection } from "mongoose";
import { sessionValidator, verifySessions, sessionIndexes } from "../../src/modules/auth/session-storage.ts";
export { sessionValidator, verifySessions } from "../../src/modules/auth/session-storage.ts";

export async function deploySessions(connection: Connection): Promise<void> {
  if (!connection.db) throw new Error("An open database is required.");
  if (await connection.db.listCollections({ name: "sessions" }).hasNext()) {
    if (await connection.db.collection("sessions").countDocuments({ $nor: [sessionValidator] }, { limit: 1 })) {
      throw new Error("Existing session data requires migration.");
    }
    await connection.db.command({ collMod: "sessions", validator: sessionValidator, validationLevel: "strict", validationAction: "error" });
  } else {
    await connection.db.createCollection("sessions", { validator: sessionValidator, validationLevel: "strict", validationAction: "error" });
  }
  await connection.db.collection("sessions").createIndexes([...sessionIndexes]);
  await verifySessions(connection);
}
