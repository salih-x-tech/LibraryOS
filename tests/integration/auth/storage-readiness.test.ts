import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { startIsolatedDatabase } from "../helpers/database";
import { deployUserIdentity } from "../../../scripts/db/identity";
import { deploySessions } from "../../../scripts/db/sessions";
import { verifyUserIdentity } from "@/modules/auth/identity-storage";
import { verifySessions } from "@/modules/auth/session-storage";

let fixture: Awaited<ReturnType<typeof startIsolatedDatabase>>;
beforeAll(async () => { fixture = await startIsolatedDatabase(); });
beforeEach(async () => { await fixture.clear(); });
afterAll(async () => { await fixture?.stop(); });

it("rejects absent storage without creating collections", async () => {
  const connection = await fixture.manager.get();
  await expect(verifyUserIdentity(connection)).rejects.toThrow();
  await expect(verifySessions(connection)).rejects.toThrow();
  expect(await connection.db!.listCollections().toArray()).toEqual([]);
});

it("accepts explicitly deployed storage without changing its definitions", async () => {
  const connection = await fixture.manager.get();
  await deployUserIdentity(connection);
  await deploySessions(connection);
  const before = await connection.db!.listCollections().toArray();
  await verifyUserIdentity(connection);
  await verifySessions(connection);
  expect(await connection.db!.listCollections().toArray()).toEqual(before);
});

it("rejects and preserves a weakened identity validator", async () => {
  const connection = await fixture.manager.get();
  await deployUserIdentity(connection);
  await connection.db!.command({ collMod: "users", validationAction: "warn" });
  await expect(verifyUserIdentity(connection)).rejects.toThrow();
  const info = await connection.db!.listCollections({ name: "users" }).next();
  expect(info).toHaveProperty("options.validationAction", "warn");
});

it("rejects missing uniqueness and expiry indexes without repairing them", async () => {
  const connection = await fixture.manager.get();
  await deployUserIdentity(connection);
  await deploySessions(connection);
  await connection.db!.collection("users").dropIndex("user_email_unique");
  await connection.db!.collection("sessions").dropIndex("session_expiry");
  await expect(verifyUserIdentity(connection)).rejects.toThrow();
  await expect(verifySessions(connection)).rejects.toThrow();
  expect(await connection.db!.collection("users").indexExists("user_email_unique")).toBe(false);
  expect(await connection.db!.collection("sessions").indexExists("session_expiry")).toBe(false);
});
