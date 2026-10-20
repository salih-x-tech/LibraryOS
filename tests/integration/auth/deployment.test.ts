import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { startIsolatedDatabase } from "../helpers/database";
import { deployInfrastructure } from "../../../scripts/db/indexes";
import { deployAuthStorage, verifyAuthStorage } from "../../../scripts/db/auth";

let fixture: Awaited<ReturnType<typeof startIsolatedDatabase>>;
beforeAll(async () => { fixture = await startIsolatedDatabase(); });
beforeEach(async () => { await fixture.clear(); });
afterAll(async () => { await fixture?.stop(); });

it("requires audit infrastructure before provisioning auth storage", async () => {
  const connection = await fixture.manager.get();
  await expect(deployAuthStorage(connection)).rejects.toThrow();
  expect(await connection.db!.listCollections().toArray()).toEqual([]);
});

it("deploys repeatably and verifies without repairing missing auth indexes", async () => {
  const connection = await fixture.manager.get();
  await deployInfrastructure(connection);
  await deployAuthStorage(connection);
  await deployAuthStorage(connection);
  await verifyAuthStorage(connection);
  await connection.db!.collection("rateLimitBuckets").dropIndex("rate_limit_expiry");
  await expect(verifyAuthStorage(connection)).rejects.toThrow();
  expect(await connection.db!.collection("rateLimitBuckets").indexExists("rate_limit_expiry")).toBe(false);
});

it("refuses incompatible existing identities and preserves their data", async () => {
  const connection = await fixture.manager.get();
  await deployInfrastructure(connection);
  await connection.db!.collection("users").insertOne({ legacy: true });
  await expect(deployAuthStorage(connection)).rejects.toThrow();
  expect(await connection.db!.collection("users").countDocuments({ legacy: true })).toBe(1);
  expect(await connection.db!.listCollections({ name: "sessions" }).hasNext()).toBe(false);
});
