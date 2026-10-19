import mongoose from "mongoose";
import { describe, expect, it, vi } from "vitest";
import { readDatabaseConfig } from "@/server/config";
import { createDatabaseConnectionManager, DatabaseConnectionError, getDatabaseConnection } from "@/server/db/connection";

const config = readDatabaseConfig({ MONGODB_URI: "mongodb://127.0.0.1:27017/", MONGODB_DB_NAME: "libraryos_test_unit", NODE_ENV: "test" });

function mockConnection() {
  const connection = new mongoose.Mongoose().createConnection();
  vi.spyOn(connection, "destroy").mockResolvedValue(undefined);
  return connection;
}

describe("database pool lifecycle", () => {
  it("shares one pool between simultaneous callers and closes it once", async () => {
    const connection = mockConnection();
    vi.spyOn(connection, "asPromise").mockResolvedValue(connection);
    const create = vi.spyOn(mongoose, "createConnection").mockReturnValue(connection);
    const manager = createDatabaseConnectionManager(config);

    const connections = await Promise.all(Array.from({ length: 8 }, () => manager.get()));
    expect(connections.every((item) => item === connection)).toBe(true);
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith(config.uri, expect.objectContaining({ autoIndex: false, autoCreate: false, bufferCommands: false, maxPoolSize: 10 }));
    await Promise.all([manager.close(), manager.close()]);
    expect(connection.destroy).toHaveBeenCalledTimes(1);
  });

  it("cleans up a failed attempt, redacts its error and allows a later retry", async () => {
    const failed = mockConnection();
    const healthy = mockConnection();
    vi.spyOn(failed, "asPromise").mockRejectedValue(new Error("synthetic driver secret"));
    vi.spyOn(healthy, "asPromise").mockResolvedValue(healthy);
    const create = vi.spyOn(mongoose, "createConnection").mockReturnValueOnce(failed).mockReturnValueOnce(healthy);
    const manager = createDatabaseConnectionManager(config);

    const failure: unknown = await manager.get().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(DatabaseConnectionError);
    expect(String(failure)).not.toContain("synthetic driver secret");
    expect(failure).not.toHaveProperty("cause");
    await expect(manager.get()).resolves.toBe(healthy);
    expect(create).toHaveBeenCalledTimes(2);
    expect(failed.destroy).toHaveBeenCalledTimes(1);
    await manager.close();
  });

  it("waits for a concurrent close before opening a replacement pool", async () => {
    const first = mockConnection();
    const replacement = mockConnection();
    const opening = Promise.withResolvers<typeof first>();
    vi.spyOn(first, "asPromise").mockReturnValue(opening.promise);
    vi.spyOn(replacement, "asPromise").mockResolvedValue(replacement);
    const create = vi.spyOn(mongoose, "createConnection").mockReturnValueOnce(first).mockReturnValueOnce(replacement);
    const manager = createDatabaseConnectionManager(config);

    const firstRequest = manager.get();
    const close = manager.close();
    const secondRequest = manager.get();
    expect(create).toHaveBeenCalledTimes(1);
    opening.resolve(first);
    await firstRequest;
    await close;
    await expect(secondRequest).resolves.toBe(replacement);
    expect(first.destroy).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledTimes(2);
    await manager.close();
  });

  it("blocks environment-driven application access during tests", () => {
    const create = vi.spyOn(mongoose, "createConnection");
    expect(() => getDatabaseConnection()).toThrow("Use an isolated fixture");
    expect(create).not.toHaveBeenCalled();
  });

  it("retains ownership after failed shutdown and permits a safe close retry", async () => {
    const connection = mockConnection();
    vi.spyOn(connection, "asPromise").mockResolvedValue(connection);
    vi.mocked(connection.destroy).mockRejectedValueOnce(new Error("synthetic shutdown secret"));
    const create = vi.spyOn(mongoose, "createConnection").mockReturnValue(connection);
    const manager = createDatabaseConnectionManager(config);
    await manager.get();

    await expect(manager.close()).rejects.toThrow(DatabaseConnectionError);
    await expect(manager.get()).resolves.toBe(connection);
    expect(create).toHaveBeenCalledTimes(1);
    await manager.close();
    expect(connection.destroy).toHaveBeenCalledTimes(2);
  });
});
