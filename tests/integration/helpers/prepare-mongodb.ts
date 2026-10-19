import { MongoBinary } from "mongodb-memory-server-core";
import { MONGODB_TEST_VERSION } from "./mongodb-version.ts";

// Download/cache before Vitest starts so first-run network time does not consume
// a test hook timeout. This prepares a binary only: no database is contacted.
try {
  console.log(`Preparing MongoDB ${MONGODB_TEST_VERSION} test binary...`);
  await MongoBinary.getPath({ version: MONGODB_TEST_VERSION });
  console.log("MongoDB test binary is ready.");
} catch {
  console.error("MongoDB test binary preparation failed. Check network access and the local binary cache.");
  process.exitCode = 1;
}
