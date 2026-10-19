import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Types } from "mongoose";
import { startIsolatedDatabase } from "../helpers/database";
import { deployUserIdentity } from "../../../scripts/db/identity";
import { getUserModel } from "@/modules/auth/user-model";
import { normalizeEmail } from "@/modules/auth/validation";
import { hashPassword, verifyPassword } from "@/modules/auth/passwords";

let fixture: Awaited<ReturnType<typeof startIsolatedDatabase>>;
const probe = {
  normalizedEmail: "student@example.com", passwordHash: "",
  status: "fixture_only", sessionVersion: 0, authorizationVersion: 0, operationFence: 0,
};
beforeAll(async () => {
  probe.passwordHash = await hashPassword("Synthetic fixture password 42!");
  fixture = await startIsolatedDatabase();
});
beforeEach(async () => {
  await fixture.clear();
  await deployUserIdentity(await fixture.manager.get());
});
afterAll(async () => { await fixture?.stop(); });

describe("global User schema", () => {
  it("hides credential hashes unless explicitly selected", async () => {
    const connection = await fixture.manager.get();
    const users = getUserModel(connection);
    await users.create(probe);
    expect(await users.findOne().lean()).not.toHaveProperty("passwordHash");
    expect(await users.findOne().select("+passwordHash").lean()).toMatchObject({ passwordHash: probe.passwordHash });
  });
  it("arbitrates normalized email uniqueness across concurrent creates", async () => {
    const users = getUserModel(await fixture.manager.get());
    const results = await Promise.allSettled([
      users.create({ ...probe, normalizedEmail: normalizeEmail(" Student@Example.com ") }),
      users.create({ ...probe, normalizedEmail: normalizeEmail("student@example.com") }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(await users.countDocuments()).toBe(1);
    const rejection = results.find((result) => result.status === "rejected");
    expect(rejection?.status === "rejected" ? rejection.reason : undefined).toMatchObject({ code: 11000 });
  });
  it("rejects tenant privileges, missing status and invalid guard counters", async () => {
    const users = getUserModel(await fixture.manager.get());
    const injectedPrivileges = { ...probe, organizationId: new Types.ObjectId(), role: "Owner" };
    await expect(users.create(injectedPrivileges)).rejects.toThrow();
    const { status, ...withoutStatus } = probe;
    expect(status).toBe("fixture_only");
    await expect(users.create(withoutStatus)).rejects.toThrow();
    await expect(users.create({ ...probe, sessionVersion: -1 })).rejects.toThrow();
    await expect(users.create({ ...probe, operationFence: 0.5 })).rejects.toThrow();
    await expect(users.create({ ...probe, normalizedEmail: "Student@Example.com" })).rejects.toThrow();
  });
  it("deploys repeatably and enforces required fields on raw database writes", async () => {
    const connection = await fixture.manager.get();
    await deployUserIdentity(connection);
    await expect(connection.db!.collection("users").insertOne({ ...probe, role: "Owner", createdAt: new Date(), updatedAt: new Date() })).rejects.toMatchObject({ code: 121 });
    await expect(connection.db!.collection("users").insertOne({ normalizedEmail: probe.normalizedEmail })).rejects.toMatchObject({ code: 121 });
    await expect(connection.db!.collection("users").insertOne({ ...probe, normalizedEmail: "Student@Example.com", createdAt: new Date(), updatedAt: new Date() })).rejects.toMatchObject({ code: 121 });
  });
  it("stores an actual verifiable hash and rejects plaintext at model/database boundaries", async () => {
    const connection = await fixture.manager.get();
    const users = getUserModel(connection);
    await users.create(probe);
    const record = await users.findOne().select("+passwordHash").lean().exec();
    expect((await verifyPassword("Synthetic fixture password 42!", record!.passwordHash)).verified).toBe(true);
    await expect(users.create({ ...probe, normalizedEmail: "other@example.com", passwordHash: "plaintext-password" })).rejects.toThrow();
    await expect(connection.db!.collection("users").insertOne({
      ...probe, normalizedEmail: "other@example.com", passwordHash: "plaintext-password", createdAt: new Date(), updatedAt: new Date(),
    })).rejects.toMatchObject({ code: 121 });
    expect(record).not.toHaveProperty("password");
  });
});
