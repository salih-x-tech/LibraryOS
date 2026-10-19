import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Types } from "mongoose";
import { startIsolatedDatabase } from "../helpers/database";
import { deployInfrastructure } from "../../../scripts/db/indexes";
import { deploySessions } from "../../../scripts/db/sessions";
import { deployUserIdentity } from "../../../scripts/db/identity";
import { deployRateLimitStorage } from "../../../scripts/db/rate-limit";
import { createAuthService, type AuthLimiter } from "@/modules/auth/service";
import { createMongoRateLimiter } from "@/server/security/rate-limit";
import { hashPassword, verifyPassword } from "@/modules/auth/passwords";
import { isSupportedPasswordHash } from "@/modules/auth/password-format";
import { getUserModel } from "@/modules/auth/user-model";
import { createRequestContext } from "@/server/http/responses";
import { ApplicationError } from "@/server/http/errors";
import { createSessionService } from "@/modules/auth/session-service";
import { APPROVED_SESSION_POLICY, SESSION_LIFETIME_MS } from "@/modules/auth/session-policy";
import { runTransaction } from "@/server/db/transaction";

vi.mock("@/modules/auth/passwords", { spy: true });
let fixture: Awaited<ReturnType<typeof startIsolatedDatabase>>;
let service: Awaited<ReturnType<typeof createAuthService>>;
let limiter: Awaited<ReturnType<typeof createMongoRateLimiter>>;
let passwordHash: string;
const userId = new Types.ObjectId();
const password = "Synthetic exact password 42!";
const body = { email: " Student@Example.com ", password };
beforeAll(async () => {
  passwordHash = await hashPassword(password);
  fixture = await startIsolatedDatabase();
});
beforeEach(async () => {
  await fixture.clear();
  const connection = await fixture.manager.get();
  await deployInfrastructure(connection);
  await deploySessions(connection);
  await deployUserIdentity(connection);
  await deployRateLimitStorage(connection);
  await getUserModel(connection).create({ _id: userId, normalizedEmail: "student@example.com", passwordHash,
    status: "active", verifiedAt: new Date(), sessionVersion: 0, authorizationVersion: 0, operationFence: 0 });
  limiter = await createMongoRateLimiter(connection, Buffer.alloc(32, 7));
  service = await createAuthService(connection, limiter);
});
afterAll(async () => { await fixture?.stop(); });

describe("login/logout application services", () => {
  it("commits an approved session and audit event and exposes only an explicit user DTO", async () => {
    const result = await service.login(body, "192.0.2.1", createRequestContext());
    expect(result.user).toEqual({ id: userId.toHexString(), email: "student@example.com" });
    expect(await service.resolveSession(result.token)).toMatchObject({ userId: userId.toHexString(), sessionVersion: 0 });
    const db = (await fixture.manager.get()).db!;
    const stored = (await db.collection("sessions").findOne())!;
    expect(stored.expiresAt.getTime() - stored.startedAt.getTime()).toBeLessThanOrEqual(SESSION_LIFETIME_MS);
    expect(JSON.stringify(stored)).not.toContain(result.token);
    expect(await db.collection("auditEvents").findOne()).toMatchObject({ scopeKind: "global", actorId: userId, action: "auth.login" });
    expect(JSON.stringify(await db.collection("auditEvents").find().toArray())).not.toMatch(/Synthetic|student@example|192\.0\.2/);
  });
  it.each(["unknown", "wrong-password", "suspended", "unverified"])("uses generic authentication failure for %s with native verification", async (mode) => {
    const connection = await fixture.manager.get();
    const credentials = { ...body };
    if (mode === "unknown") credentials.email = "unknown@example.com";
    if (mode === "wrong-password") credentials.password = "incorrect";
    if (mode === "suspended") await getUserModel(connection).updateOne({}, { $set: { status: "suspended" } });
    if (mode === "unverified") await getUserModel(connection).updateOne({}, { $unset: { verifiedAt: 1 } });
    await expect(service.login(credentials, "192.0.2.1", createRequestContext())).rejects.toMatchObject({ code: "UNAUTHENTICATED", message: "Authentication is required." });
    expect(verifyPassword).toHaveBeenCalledTimes(1);
    expect(isSupportedPasswordHash(vi.mocked(verifyPassword).mock.calls[0]![1])).toBe(true);
    expect(await connection.db!.collection("sessions").countDocuments()).toBe(0);
    expect(await connection.db!.collection("auditEvents").countDocuments()).toBe(0);
  });
  it("limits failed credentials before performing a sixth native verification", async () => {
    for (let index = 0; index < 5; index++) {
      await expect(service.login({ ...body, password: "incorrect" }, "192.0.2.1", createRequestContext())).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    }
    await expect(service.login(body, "192.0.2.1", createRequestContext())).rejects.toMatchObject({ code: "RATE_LIMITED" });
    expect(verifyPassword).toHaveBeenCalledTimes(5);
  });
  it("releases successful permits and applies the browser cap across actual logins", async () => {
    const results = [];
    for (let index = 0; index < 5; index++) results.push(await service.login(body, "192.0.2.1", createRequestContext()));
    expect(await service.resolveSession(results[0]!.token)).toBeNull();
    expect(await service.resolveSession(results[4]!.token)).not.toBeNull();
    const db = (await fixture.manager.get()).db!;
    expect(await db.collection("sessions").countDocuments({ revokedAt: { $exists: false } })).toBe(3);
    expect(await db.collection("rateLimitBuckets").findOne({ kind: "login.account" })).toMatchObject({ count: 0 });
  });
  it("rejects writable privilege fields before consuming a permit", async () => {
    const connection = await fixture.manager.get();
    await expect(service.login({ ...body, role: "Owner" }, "192.0.2.1", createRequestContext())).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(verifyPassword).not.toHaveBeenCalled();
    expect(await connection.db!.collection("rateLimitBuckets").countDocuments()).toBe(0);
  });
  it("rejects a credential snapshot invalidated after verification but before session issuance", async () => {
    const connection = await fixture.manager.get();
    const racingLimiter: AuthLimiter = { beginLogin: async (...args) => {
      const permit = await limiter.beginLogin(...args);
      return { complete: async (outcome) => {
        await permit.complete(outcome);
        if (outcome === "success") await getUserModel(connection).updateOne({}, { $inc: { sessionVersion: 1 } });
      } };
    } };
    const racing = await createAuthService(connection, racingLimiter);
    await expect(racing.login(body, "192.0.2.1", createRequestContext())).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    expect(await connection.db!.collection("sessions").countDocuments()).toBe(0);
  });
  it("rolls back login session creation if mandatory audit persistence fails", async () => {
    const connection = await fixture.manager.get();
    await connection.db!.command({ collMod: "auditEvents", validator: { $jsonSchema: { required: ["syntheticMissingField"] } }, validationAction: "error" });
    await expect(service.login(body, "192.0.2.1", createRequestContext())).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
    expect(await connection.db!.collection("sessions").countDocuments()).toBe(0);
    expect(await getUserModel(connection).findById(userId).lean()).toMatchObject({ operationFence: 0 });
  });
  it("revokes the current browser family and audits logout only once", async () => {
    const result = await service.login(body, "192.0.2.1", createRequestContext());
    await service.logout(result.token, createRequestContext());
    await service.logout(result.token, createRequestContext());
    await service.logout("invalid", createRequestContext());
    expect(await service.resolveSession(result.token)).toBeNull();
    const db = (await fixture.manager.get()).db!;
    expect(await db.collection("auditEvents").countDocuments({ action: "auth.logout" })).toBe(1);
  });
  it("can revoke a rotated browser without affecting a separately logged-in browser", async () => {
    const result = await service.login(body, "192.0.2.1", createRequestContext());
    const other = await service.login(body, "192.0.2.1", createRequestContext());
    const connection = await fixture.manager.get();
    const sessions = createSessionService(connection, APPROVED_SESSION_POLICY);
    const rotated = await runTransaction(connection, (context) => sessions.rotate(context, result.token, result.expiresAt));
    await service.logout(result.token, createRequestContext());
    expect(await service.resolveSession(rotated.token)).toBeNull();
    expect(await service.resolveSession(other.token)).not.toBeNull();
  });
  it("rolls back logout when mandatory audit persistence fails", async () => {
    const result = await service.login(body, "192.0.2.1", createRequestContext());
    const connection = await fixture.manager.get();
    await connection.db!.command({ collMod: "auditEvents", validator: { $jsonSchema: { required: ["syntheticMissingField"] } }, validationAction: "error" });
    await expect(service.logout(result.token, createRequestContext())).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
    expect(await service.resolveSession(result.token)).not.toBeNull();
  });
  it("fails closed before credential verification if the shared limiter is unavailable", async () => {
    const blocked = await createAuthService(await fixture.manager.get(), { beginLogin: async () => { throw new ApplicationError("SERVICE_UNAVAILABLE"); } });
    await expect(blocked.login(body, "192.0.2.1", createRequestContext())).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
    expect(verifyPassword).not.toHaveBeenCalled();
  });
});
