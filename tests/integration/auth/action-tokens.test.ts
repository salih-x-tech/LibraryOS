import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { Types } from "mongoose";
import { startIsolatedDatabase } from "../helpers/database";
import { deployActionTokens } from "../../../scripts/db/action-tokens";
import { verifyActionTokens } from "@/modules/auth/action-token-storage";
import { createActionTokenStore } from "@/modules/auth/action-tokens";
import { getActionTokenModel } from "@/modules/auth/action-token-model";
import { runTransaction, type TransactionContext } from "@/server/db/transaction";

let fixture: Awaited<ReturnType<typeof startIsolatedDatabase>>;
const identity = { userId: new Types.ObjectId().toHexString(), sessionVersion: 3 };
beforeAll(async () => { fixture = await startIsolatedDatabase(); });
beforeEach(async () => { await fixture.clear(); await deployActionTokens(await fixture.manager.get()); });
afterAll(async () => { await fixture?.stop(); });

it("stores only a private hash and consumes the correct purpose exactly once", async () => {
  const connection = await fixture.manager.get();
  const store = createActionTokenStore(connection);
  const issued = await runTransaction(connection, (transaction) => store.issue(transaction, identity, "verify-email", new Date(Date.now() + 60_000)));
  expect(await getActionTokenModel(connection).findOne().lean()).not.toHaveProperty("tokenHash");
  expect(JSON.stringify(await connection.db!.collection("authActionTokens").findOne())).not.toContain(issued.token);
  expect(await runTransaction(connection, (transaction) => store.consume(transaction, "reset-password", issued.token))).toBeNull();
  expect(await runTransaction(connection, (transaction) => store.consume(transaction, "verify-email", issued.token))).toEqual(identity);
  expect(await runTransaction(connection, (transaction) => store.consume(transaction, "verify-email", issued.token))).toBeNull();
});

it("has only one winner under concurrent token consumption", async () => {
  const connection = await fixture.manager.get();
  const store = createActionTokenStore(connection);
  const issued = await runTransaction(connection, (transaction) => store.issue(transaction, identity, "reset-password", new Date(Date.now() + 60_000)));
  const results = await Promise.all(Array.from({ length: 4 }, () => runTransaction(connection, (transaction) => store.consume(transaction, "reset-password", issued.token))));
  expect(results.filter(Boolean)).toEqual([identity]);
});

it("rejects expired records before TTL cleanup and malformed input", async () => {
  const connection = await fixture.manager.get();
  const store = createActionTokenStore(connection);
  const issued = await runTransaction(connection, (transaction) => store.issue(transaction, identity, "reset-password", new Date(Date.now() + 60_000)));
  await connection.db!.collection("authActionTokens").updateOne({}, { $set: { createdAt: new Date(Date.now() - 120_000), expiresAt: new Date(Date.now() - 60_000) } });
  expect(await runTransaction(connection, (transaction) => store.consume(transaction, "reset-password", issued.token))).toBeNull();
  expect(await runTransaction(connection, (transaction) => store.consume(transaction, "reset-password", "invalid"))).toBeNull();
});

it("rolls back consumption with the enclosing account operation", async () => {
  const connection = await fixture.manager.get();
  const store = createActionTokenStore(connection);
  const issued = await runTransaction(connection, (transaction) => store.issue(transaction, identity, "reset-password", new Date(Date.now() + 60_000)));
  await expect(runTransaction(connection, async (transaction) => {
    expect(await store.consume(transaction, "reset-password", issued.token)).toEqual(identity);
    throw new Error("Synthetic account/audit failure");
  })).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
  expect(await runTransaction(connection, (transaction) => store.consume(transaction, "reset-password", issued.token))).toEqual(identity);
});

it("requires a real transaction, explicit future deadline and valid identity version", async () => {
  const connection = await fixture.manager.get();
  const store = createActionTokenStore(connection);
  const session = await connection.startSession();
  try {
    await expect(store.issue({ session } as TransactionContext, identity, "verify-email", new Date(Date.now() + 60_000))).rejects.toThrow("transaction");
    await expect(runTransaction(connection, (transaction) => store.issue(transaction, identity, "verify-email", new Date(0)))).rejects.toThrow();
    await expect(runTransaction(connection, (transaction) => store.issue(transaction, { ...identity, sessionVersion: -1 }, "verify-email", new Date(Date.now() + 60_000)))).rejects.toThrow();
    expect(await connection.db!.collection("authActionTokens").countDocuments()).toBe(0);
  } finally { await session.endSession(); }
});

it("verifies repeat deployment and refuses weakened storage without repairing it", async () => {
  const connection = await fixture.manager.get();
  await deployActionTokens(connection);
  await verifyActionTokens(connection);
  await connection.db!.collection("authActionTokens").dropIndex("auth_action_token_unique");
  await expect(verifyActionTokens(connection)).rejects.toThrow();
  expect(await connection.db!.collection("authActionTokens").indexExists("auth_action_token_unique")).toBe(false);
  await deployActionTokens(connection);
  await connection.db!.command({ collMod: "authActionTokens", validationAction: "warn" });
  await expect(verifyActionTokens(connection)).rejects.toThrow();
});

it("rejects raw-token and authority fields, invalid purposes and duplicate digests", async () => {
  const connection = await fixture.manager.get();
  const store = createActionTokenStore(connection);
  const issued = await runTransaction(connection, (transaction) => store.issue(transaction, identity, "verify-email", new Date(Date.now() + 60_000)));
  const collection = connection.db!.collection("authActionTokens");
  const record = (await collection.findOne())!;
  for (const extra of [{ token: issued.token }, { role: "Owner" }, { purpose: "login" }, { sessionVersion: -1 }]) {
    await expect(collection.insertOne({ ...record, _id: new Types.ObjectId(), ...extra })).rejects.toMatchObject({ code: 121 });
  }
  await expect(collection.insertOne({ ...record, _id: new Types.ObjectId() })).rejects.toMatchObject({ code: 11000 });
});
