import mongoose from "mongoose";
import { readDatabaseConfig } from "../../src/server/config.ts";
import { verifyAuthStorage } from "./auth.ts";
import { deployActionTokens } from "./action-tokens.ts";
import { deployRecoveryRequests } from "./recovery-requests.ts";
import { verifyActionTokens } from "../../src/modules/auth/action-token-storage.ts";
import { verifyRecoveryRequests } from "../../src/modules/auth/recovery-request-storage.ts";

const args = process.argv.slice(2);
const mode = args[0] ?? "--plan";
if (mode === "--plan" && args.length <= 1) {
  console.log("Recovery plan: authActionTokens and authRecoveryRequests strict validators and indexes. Requires verified infrastructure/auth storage. Apply is sequential; review partial failure before retry. No connection or delivery is started.");
} else {
  let connection: mongoose.Connection | undefined;
  try {
    if (!["--apply", "--verify"].includes(mode) || args.length !== 3 || args[1] !== "--database") throw new Error();
    const config = readDatabaseConfig();
    if (args[2] !== config.databaseName || process.env.NODE_ENV === "test") throw new Error();
    connection = mongoose.createConnection(config.uri, { dbName: config.databaseName, autoCreate: false,
      autoIndex: false, serverSelectionTimeoutMS: 10_000 });
    connection.on("error", () => {}); await connection.asPromise();
    await verifyAuthStorage(connection);
    if (mode === "--apply") { await deployActionTokens(connection); await deployRecoveryRequests(connection); }
    await verifyActionTokens(connection); await verifyRecoveryRequests(connection);
    console.log("Recovery storage check passed. No mail sent or worker scheduled.");
  } catch {
    console.error("Recovery deployment/check failed. Review prerequisites and partial migration state. No secrets are printed.");
    process.exitCode = 1;
  } finally { await connection?.close().catch(() => { process.exitCode = 1; }); }
}
