import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { startIsolatedDatabase } from "../helpers/database";
import { deployInfrastructure } from "../../../scripts/db/indexes";
import { deployAuthStorage } from "../../../scripts/db/auth";
import { createAuthService } from "@/modules/auth/service";
import { createMongoRateLimiter } from "@/server/security/rate-limit";
import { createProfileService } from "@/modules/auth/profile-service";
import { getUserModel } from "@/modules/auth/user-model";
import { hashPassword } from "@/modules/auth/passwords";
import { createRequestContext } from "@/server/http/responses";
import { validators } from "@/server/db/validators";

let fixture: Awaited<ReturnType<typeof startIsolatedDatabase>>;
let auth: Awaited<ReturnType<typeof createAuthService>>;
let profile: ReturnType<typeof createProfileService>;
let token: string;
let passwordHash: string;
beforeAll(async () => { fixture = await startIsolatedDatabase(); passwordHash = await hashPassword("Synthetic profile password!"); });
beforeEach(async () => {
  await fixture.clear(); const connection = await fixture.manager.get();
  await deployInfrastructure(connection); await deployAuthStorage(connection);
  await getUserModel(connection).create([{ normalizedEmail: "self@example.com", passwordHash, status: "active", verifiedAt: new Date(),
    sessionVersion: 0, authorizationVersion: 0, operationFence: 0 }, { normalizedEmail: "other@example.com", passwordHash,
    status: "active", verifiedAt: new Date(), sessionVersion: 0, authorizationVersion: 0, operationFence: 0, displayName: "Other" }]);
  auth = await createAuthService(connection, await createMongoRateLimiter(connection, Buffer.alloc(32, 6)));
  token = (await auth.login({ email: "self@example.com", password: "Synthetic profile password!" }, "192.0.2.1", createRequestContext())).token;
  profile = createProfileService(connection);
});
afterAll(async () => { await fixture?.stop(); });
it("updates only the authenticated profile and projects no security fields", async () => {
  const result = await profile.update(token, { displayName: " Reader " }, createRequestContext());
  expect(result).toMatchObject({ email: "self@example.com", displayName: "Reader" });
  expect(Object.keys(result).sort()).toEqual(["displayName", "email", "id"]);
  const db = (await fixture.manager.get()).db!;
  expect(await db.collection("users").findOne({ normalizedEmail: "other@example.com" })).toMatchObject({ displayName: "Other" });
  const audit = await db.collection("auditEvents").findOne({ action: "auth.profileUpdated" });
  expect(audit).toMatchObject({ changedFields: ["displayName"] });
  expect(JSON.stringify(audit)).not.toContain("Reader");
  expect((await profile.read(token)).user).toEqual(result);
});
it("rejects authority and sensitive edits and refuses revoked sessions", async () => {
  for (const value of [{ displayName: "Reader", userId: "other" }, { email: "other@example.com" }, { password: "new" }]) {
    await expect(profile.update(token, value, createRequestContext())).rejects.toMatchObject({ code: "BAD_REQUEST" });
  }
  await auth.logout(token, createRequestContext());
  await expect(profile.update(token, { displayName: "Reader" }, createRequestContext())).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
});
it("rolls back the profile edit when mandatory audit fails", async () => {
  const db = (await fixture.manager.get()).db!;
  await db.command({ collMod: "auditEvents", validator: { $expr: { $eq: [1, 0] } } });
  await expect(profile.update(token, { displayName: "Rollback" }, createRequestContext())).rejects.toThrow();
  expect(await db.collection("users").findOne({ normalizedEmail: "self@example.com" })).not.toHaveProperty("displayName");
  await db.command({ collMod: "auditEvents", validator: validators.auditEvents });
});
