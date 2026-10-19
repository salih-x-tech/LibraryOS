import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { startIsolatedDatabase } from "./helpers/database";
import { mongo, Types } from "mongoose";
import { runTransaction } from "@/server/db/transaction";
import { ApplicationError } from "@/server/http/errors";
import { createTenantScope, tenantFilter } from "@/server/db/scope";

type Probe = { _id: string; value: number };
let fixture: Awaited<ReturnType<typeof startIsolatedDatabase>>;

beforeAll(async () => {
  fixture = await startIsolatedDatabase();
});

beforeEach(async () => {
  await fixture.clear();
  const connection = await fixture.manager.get();
  if (!connection.db) throw new Error("Expected an open test database");
  await connection.db.createCollection("connection_probes");
});

afterAll(async () => {
  await fixture?.stop();
});

describe("owned replica-set fixture and real Mongoose connection", () => {
  it("isolates tenant reads and writes even when an additional predicate selects a foreign tenant", async () => {
    const connection = await fixture.manager.get();
    const records = connection.db!.collection("connection_probes");
    const a = new Types.ObjectId();
    const b = new Types.ObjectId();
    await records.insertMany([{ organizationId: a, value: 1 }, { organizationId: b, value: 2 }]);
    const scope = createTenantScope(a.toHexString());
    expect(await records.countDocuments(tenantFilter(scope, {}))).toBe(1);
    expect(await records.countDocuments(tenantFilter(scope, { organizationId: b }))).toBe(0);
    const result = await records.updateMany(tenantFilter(scope, { $or: [{ organizationId: b }, {}] }), { $set: { value: 3 } });
    expect(result.modifiedCount).toBe(1);
    expect(await records.findOne({ organizationId: b })).toMatchObject({ value: 2 });
  });
  it("commits sequential writes through the shared transaction helper", async () => {
    const connection = await fixture.manager.get();
    const probes = connection.db!.collection<Probe>("connection_probes");
    let ownedSession: import("mongoose").ClientSession | undefined;
    const result = await runTransaction(connection, async ({ session }) => {
      ownedSession = session;
      await probes.insertOne({ _id: "first", value: 1 }, { session });
      await probes.insertOne({ _id: "second", value: 2 }, { session });
      return "done";
    });
    expect(result).toBe("done");
    expect(await probes.countDocuments()).toBe(2);
    expect(ownedSession?.hasEnded).toBe(true);
  });

  it("rolls back every write and preserves business rejection", async () => {
    const connection = await fixture.manager.get();
    const probes = connection.db!.collection<Probe>("connection_probes");
    const rejection = new ApplicationError("CONFLICT");
    await expect(runTransaction(connection, async ({ session }) => {
      await probes.insertOne({ _id: "first", value: 1 }, { session });
      await probes.insertOne({ _id: "second", value: 2 }, { session });
      throw rejection;
    })).rejects.toBe(rejection);
    expect(await probes.countDocuments()).toBe(0);
  });

  it("lets the real driver retry a transient callback failure without duplicate writes", async () => {
    const connection = await fixture.manager.get();
    const probes = connection.db!.collection<Probe>("connection_probes");
    let attempts = 0;
    await runTransaction(connection, async ({ session }) => {
      attempts++;
      await probes.insertOne({ _id: "retry", value: attempts }, { session });
      if (attempts === 1) {
        const transient = new mongo.MongoServerError({ message: "synthetic transient test failure", code: 112 });
        transient.addErrorLabel("TransientTransactionError");
        throw transient;
      }
    });
    expect(attempts).toBe(2);
    expect(await probes.findOne({ _id: "retry" })).toMatchObject({ value: 2 });
    expect(await probes.countDocuments()).toBe(1);
  });

  it("opens the generated database and shares its pool across concurrent callers", async () => {
    const connections = await Promise.all(Array.from({ length: 8 }, () => fixture.manager.get()));
    const connection = connections[0];
    if (!connection?.db) throw new Error("Expected an open test database");
    expect(connections.every((item) => item === connection)).toBe(true);
    expect(connection.name).toBe(fixture.databaseName);
    expect(connection.host).toBe("127.0.0.1");
    expect((await connection.db.admin().command({ ping: 1 })).ok).toBe(1);
  });

  it("supports transaction commit and rollback on a real replica set", async () => {
    const connection = await fixture.manager.get();
    if (!connection.db) throw new Error("Expected an open test database");
    const probes = connection.db.collection<Probe>("connection_probes");
    const session = await connection.startSession();
    try {
      await session.withTransaction(async () => {
        await probes.insertOne({ _id: "committed", value: 1 }, { session });
      });
      await expect(session.withTransaction(async () => {
        await probes.insertOne({ _id: "rolled_back", value: 2 }, { session });
        throw new Error("abort test transaction");
      })).rejects.toThrow("abort test transaction");
      expect(await probes.countDocuments({ _id: "committed" })).toBe(1);
      expect(await probes.countDocuments({ _id: "rolled_back" })).toBe(0);
    } finally {
      await session.endSession();
    }
  });

  it("refuses destructive cleanup when the owned database identity no longer matches", async () => {
    const connection = await fixture.manager.get();
    const nameDescriptor = Object.getOwnPropertyDescriptor(connection, "name");
    if (!nameDescriptor) throw new Error("Expected the connection identity to be an own property");
    const drop = vi.spyOn(connection, "dropDatabase");
    try {
      Object.defineProperty(connection, "name", { ...nameDescriptor, value: "not_the_owned_test_database" });
      await expect(fixture.clear()).rejects.toThrow("Refusing cleanup");
      expect(drop).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(connection, "name", nameDescriptor);
      drop.mockRestore();
    }
  });

  it("does not read an application URI and cannot clear another fixture's records", async () => {
    vi.stubEnv("MONGODB_URI", "mongodb://must-not-be-used.example.invalid/");
    let other: Awaited<ReturnType<typeof startIsolatedDatabase>> | undefined;
    try {
      other = await startIsolatedDatabase();
      const connection = await fixture.manager.get();
      const otherConnection = await other.manager.get();
      if (!connection.db || !otherConnection.db) throw new Error("Expected open test databases");
      await connection.db.collection<Probe>("connection_probes").insertOne({ _id: "original", value: 1 });
      expect(other.databaseName).not.toBe(fixture.databaseName);
      expect(await otherConnection.db.collection("connection_probes").countDocuments()).toBe(0);
      await other.clear();
      expect(await connection.db.collection("connection_probes").countDocuments()).toBe(1);
    } finally {
      vi.unstubAllEnvs();
      await other?.stop();
    }
  });
});
