import { randomUUID } from "node:crypto";
import { MongoMemoryReplSet } from "mongodb-memory-server-core";
import { readDatabaseConfig } from "@/server/config";
import { createDatabaseConnectionManager } from "@/server/db/connection";
import { MONGODB_TEST_VERSION } from "./mongodb-version.ts";

export async function startIsolatedDatabase() {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("Disposable database fixtures require NODE_ENV=test.");
  }

  const databaseName = `libraryos_test_${randomUUID().replaceAll("-", "")}`;
  const replicaSet = await MongoMemoryReplSet.create({
    binary: { version: MONGODB_TEST_VERSION },
    replSet: {
      count: 1,
      ip: "127.0.0.1",
      storageEngine: "wiredTiger",
    },
  });

  try {
    const uri = replicaSet.getUri(databaseName);
    const endpoint = new URL(uri);
    if (endpoint.protocol !== "mongodb:" || endpoint.hostname !== "127.0.0.1" || endpoint.username || endpoint.password) {
      throw new Error("The disposable database must be an owned loopback instance.");
    }

    const manager = createDatabaseConnectionManager(readDatabaseConfig({
      NODE_ENV: "test",
      MONGODB_URI: uri,
      MONGODB_DB_NAME: databaseName,
    }));

    return {
      uri,
      databaseName,
      manager,
      async clear(): Promise<void> {
        const connection = await manager.get();
        // Destructive cleanup is closed over the fixture's generated identity.
        // This helper never accepts a caller-supplied URI or arbitrary connection.
        if (connection.name !== databaseName || !databaseName.startsWith("libraryos_test_") || connection.host !== "127.0.0.1" || connection.port !== Number(endpoint.port)) {
          throw new Error("Refusing cleanup outside the owned test database.");
        }
        await connection.dropDatabase();
      },
      async stop(): Promise<void> {
        try {
          await manager.close();
        } finally {
          await replicaSet.stop();
        }
      },
    };
  } catch (error: unknown) {
    await replicaSet.stop();
    throw error;
  }
}
