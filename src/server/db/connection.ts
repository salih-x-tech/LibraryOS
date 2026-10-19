import "server-only";
import mongoose, { type Connection } from "mongoose";
import { readDatabaseConfig, type DatabaseConfig } from "@/server/config";

export class DatabaseConnectionError extends Error {
  readonly code = "DATABASE_CONNECTION_FAILED";

  constructor() {
    super("The database connection is unavailable.");
    this.name = "DatabaseConnectionError";
  }
}

export type DatabaseConnectionManager = Readonly<{
  get: () => Promise<Connection>;
  close: () => Promise<void>;
}>;

// One manager owns one pool. Tests use their own manager and generated URI.
export function createDatabaseConnectionManager(config: DatabaseConfig): DatabaseConnectionManager {
  let pending: Promise<Connection> | undefined;
  let closing: Promise<void> | undefined;

  async function get(): Promise<Connection> {
    if (closing) await closing;
    if (pending) return pending;

    let connection: Connection;
    try {
      connection = mongoose.createConnection(config.uri, {
        dbName: config.databaseName,
        maxPoolSize: 10,
        minPoolSize: 0,
        serverSelectionTimeoutMS: 5_000,
        connectTimeoutMS: 5_000,
        waitQueueTimeoutMS: 5_000,
        autoIndex: false,
        autoCreate: false,
        bufferCommands: false,
        writeConcern: { w: "majority" },
      });
    } catch {
      throw new DatabaseConnectionError();
    }

    // Consume emitter errors without logging URI/driver details. Callers receive
    // operation errors; structured operational reporting follows in Task 2.2.
    connection.on("error", () => {});
    pending = connection.asPromise().catch(async () => {
      await connection.destroy().catch(() => undefined);
      pending = undefined;
      throw new DatabaseConnectionError();
    });
    return pending;
  }

  async function close(): Promise<void> {
    if (closing) return closing;
    const toClose = pending;
    if (!toClose) return;
    let closed = false;

    closing = (async () => {
      const connection = await toClose.catch(() => undefined);
      if (connection) {
        try {
          await connection.destroy();
        } catch {
          throw new DatabaseConnectionError();
        }
      }
      closed = true;
    })().finally(() => {
      // If shutdown failed, retain ownership and allow close() to retry rather
      // than opening a second pool while the first may still be alive.
      if (closed && pending === toClose) pending = undefined;
      closing = undefined;
    });
    return closing;
  }

  return Object.freeze({ get, close });
}

// Reuse the pool across Next.js development module reloads in this process.
const processState = globalThis as typeof globalThis & {
  libraryOSDatabase?: DatabaseConnectionManager;
};

export function getDatabaseConnection(): Promise<Connection> {
  if (process.env.NODE_ENV === "test") {
    throw new Error("Application database access is disabled in tests. Use an isolated fixture.");
  }
  processState.libraryOSDatabase ??= createDatabaseConnectionManager(readDatabaseConfig());
  return processState.libraryOSDatabase.get();
}

export async function closeDatabaseConnection(): Promise<void> {
  await processState.libraryOSDatabase?.close();
}
