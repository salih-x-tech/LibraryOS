import mongoose from "mongoose";
import { readDatabaseConfig } from "../../src/server/config.ts";
import { deployAuthStorage, verifyAuthStorage } from "./auth.ts";

const args = process.argv.slice(2);
const mode = args[0] ?? "--plan";
if (mode === "--plan" && args.length <= 1) {
  console.log("Auth plan: users, sessions, rateLimitBuckets, loginRateLimitAttempts; strict validators, identity uniqueness and expiry indexes. Requires deployed Phase 2 infrastructure. Apply is sequential, not atomic; review partial failures before retrying. No connection opened.");
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
    if (mode === "--apply") await deployAuthStorage(connection);
    else await verifyAuthStorage(connection);
    console.log("Auth storage check passed.");
  } catch {
    console.error("Auth deployment/check failed. Review configuration, privileges, prerequisites and partial migration state. No secrets are printed.");
    process.exitCode = 1;
  } finally {
    await connection?.close().catch(() => { process.exitCode = 1; });
  }
}
