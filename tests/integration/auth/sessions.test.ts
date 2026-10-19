import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Types } from "mongoose";
import { startIsolatedDatabase } from "../helpers/database";
import { deploySessions } from "../../../scripts/db/sessions";
import { getSessionModel } from "@/modules/auth/session-model";
import { createSessionCredential } from "@/modules/auth/sessions";

let fixture: Awaited<ReturnType<typeof startIsolatedDatabase>>;
beforeAll(async () => { fixture = await startIsolatedDatabase(); });
beforeEach(async () => {
  await fixture.clear();
  await deploySessions(await fixture.manager.get());
});
afterAll(async () => { await fixture?.stop(); });

describe("session storage", () => {
  it("persists only the token hash and rejects duplicate token hashes", async () => {
    const connection = await fixture.manager.get();
    const sessions = getSessionModel(connection);
    const credential = createSessionCredential();
    const record = { tokenHash: credential.tokenHash, userId: new Types.ObjectId(), familyId: new Types.ObjectId(), startedAt: new Date(), lastSeenAt: new Date(), expiresAt: new Date(Date.now() + 60_000), sessionVersion: 0 };
    await sessions.create(record);
    expect(await sessions.findOne().lean()).not.toHaveProperty("tokenHash");
    const stored = await connection.db!.collection("sessions").findOne();
    expect(stored?.tokenHash).toBe(credential.tokenHash);
    expect(JSON.stringify(stored)).not.toContain(credential.token);
    await expect(sessions.create(record)).rejects.toMatchObject({ code: 11000 });
  });
  it("rejects raw tokens, authority fields, invalid counters and missing expiry", async () => {
    const connection = await fixture.manager.get();
    const credential = createSessionCredential();
    const record = { tokenHash: credential.tokenHash, userId: new Types.ObjectId(), familyId: new Types.ObjectId(), startedAt: new Date(), lastSeenAt: new Date(), expiresAt: new Date(Date.now() + 60_000), sessionVersion: 0, createdAt: new Date(), updatedAt: new Date() };
    await expect(connection.db!.collection("sessions").insertOne({ ...record, token: credential.token })).rejects.toMatchObject({ code: 121 });
    await expect(connection.db!.collection("sessions").insertOne({ ...record, role: "Owner" })).rejects.toMatchObject({ code: 121 });
    await expect(connection.db!.collection("sessions").insertOne({ ...record, sessionVersion: -1 })).rejects.toMatchObject({ code: 121 });
    const { expiresAt, ...withoutExpiry } = record;
    expect(expiresAt).toBeInstanceOf(Date);
    await expect(connection.db!.collection("sessions").insertOne(withoutExpiry)).rejects.toMatchObject({ code: 121 });
  });
  it("deploys repeatably with user lookup and expiry indexes", async () => {
    const connection = await fixture.manager.get();
    await deploySessions(connection);
    const indexes = await connection.db!.collection("sessions").listIndexes().toArray();
    expect(indexes.find((index) => index.name === "session_expiry")).toMatchObject({ key: { expiresAt: 1 }, expireAfterSeconds: 0 });
    expect(indexes.find((index) => index.name === "session_user")).toMatchObject({ key: { userId: 1 } });
  });
});
