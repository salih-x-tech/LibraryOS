import mongoose from "mongoose";
import { readDatabaseConfig } from "../../src/server/config.ts";
import { deployInfrastructure, verifyInfrastructure } from "./indexes.ts";

// Plan is local/read-only; apply/verify require an explicit matching database name.
const args = process.argv.slice(2);
const mode = args[0] ?? "--plan";
if (mode === "--plan" && args.length <= 1) {
  console.log("Phase 2 plan: auditEvents, outboxEvents, idempotencyRecords; strict validators and six named indexes. No connection opened.");
} else {
  let connection: mongoose.Connection | undefined;
  try {
    if (!["--apply", "--verify"].includes(mode) || args.length !== 3 || args[1] !== "--database") throw new Error("Invalid deployment arguments.");
    const config = readDatabaseConfig();
    if (args[2] !== config.databaseName || process.env.NODE_ENV === "test") throw new Error("Database confirmation failed.");
    connection = mongoose.createConnection(config.uri, {
      dbName: config.databaseName, autoCreate: false, autoIndex: false, serverSelectionTimeoutMS: 10_000,
    });
    connection.on("error", () => {});
    await connection.asPromise();
    if (mode === "--apply") await deployInfrastructure(connection);
    else await verifyInfrastructure(connection);
    console.log("Phase 2 infrastructure check passed.");
  } catch {
    console.error("Infrastructure deployment/check failed. Review configuration, database privileges and migration requirements. No secrets are printed.");
    process.exitCode = 1;
  } finally {
    await connection?.close().catch(() => { process.exitCode = 1; });
  }
}
