import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { startIsolatedDatabase } from "../helpers/database";
import { deployInfrastructure } from "../../../scripts/db/indexes";
import { deployAuthStorage } from "../../../scripts/db/auth";
import { deployActionTokens } from "../../../scripts/db/action-tokens";
import { createLocalRecoveryService, createTestRecoveryService } from "@/modules/auth/recovery-service";
import { createNewPasswordValidator } from "@/modules/auth/new-password";
import { createMongoRateLimiter } from "@/server/security/rate-limit";
import { getUserModel } from "@/modules/auth/user-model";
import { hashPassword, verifyPassword } from "@/modules/auth/passwords";
import { createRequestContext } from "@/server/http/responses";
import { createSessionService } from "@/modules/auth/session-service";
import { APPROVED_SESSION_POLICY } from "@/modules/auth/session-policy";
import { runTransaction } from "@/server/db/transaction";
import { validators } from "@/server/db/validators";
import { hashActionToken } from "@/modules/auth/action-token-format";

let fixture: Awaited<ReturnType<typeof startIsolatedDatabase>>;
let passwordHash: string;
let service: Awaited<ReturnType<typeof createTestRecoveryService>>;
let limiter: Awaited<ReturnType<typeof createMongoRateLimiter>>;
const send = vi.fn();
const ready = vi.fn();
const oldPassword = "A previous synthetic passphrase!";
const newPassword = "A fresh synthetic passphrase!";
const email = "reader@example.com";
const ip = "192.0.2.1";
const context = () => createRequestContext();
const token = (index = -1) => new URL(send.mock.calls.at(index)![0].url).hash.slice("#token=".length);
beforeAll(async () => { fixture = await startIsolatedDatabase(); passwordHash = await hashPassword(oldPassword); });
beforeEach(async () => {
  await fixture.clear(); send.mockReset().mockResolvedValue(undefined); ready.mockReset().mockResolvedValue(undefined);
  const connection = await fixture.manager.get();
  await deployInfrastructure(connection); await deployAuthStorage(connection); await deployActionTokens(connection);
  await getUserModel(connection).create({ normalizedEmail: email, passwordHash, status: "active", verifiedAt: new Date(), sessionVersion: 0, authorizationVersion: 0, operationFence: 0 });
  limiter = await createMongoRateLimiter(connection, Buffer.alloc(32, 8));
  service = await createTestRecoveryService(connection, limiter, { kind: "synthetic-memory", send, ready },
    { origin: "https://127.0.0.1:3102", blocklist: ["a compromised test phrase"] });
});
afterAll(async () => { await fixture?.stop(); });

it("delivers only after commit, with approved expiry and no persisted raw link", async () => {
  const connection = await fixture.manager.get();
  send.mockImplementationOnce(async () => {
    expect(await connection.db!.collection("authActionTokens").countDocuments()).toBe(1);
    expect(await connection.db!.collection("auditEvents").countDocuments()).toBe(1);
  });
  await expect(service.request("reset-password", email, ip, context())).resolves.toBeUndefined();
  const record = (await connection.db!.collection("authActionTokens").findOne())!;
  expect(record.expiresAt.getTime() - record.createdAt.getTime()).toBeGreaterThan(29 * 60_000);
  expect(record.expiresAt.getTime() - record.createdAt.getTime()).toBeLessThanOrEqual(30 * 60_000);
  expect(JSON.stringify(await connection.db!.collection("auditEvents").find().toArray())).not.toMatch(/reader@example|#token=/);
  expect(JSON.stringify(record)).not.toContain(token());
});

it("keeps unknown and ineligible requests generic and performs shared readiness checks", async () => {
  await service.request("reset-password", "unknown@example.com", ip, context());
  await service.request("verify-email", email, ip, context());
  const connection = await fixture.manager.get();
  await getUserModel(connection).updateOne({}, { $set: { status: "suspended" } });
  await service.request("reset-password", email, ip, context());
  expect(send).not.toHaveBeenCalled(); expect(ready).toHaveBeenCalledTimes(3);
});

it("reissues under the user guard and rejects the replaced link", async () => {
  await service.request("reset-password", email, ip, context()); const old = token();
  await service.request("reset-password", email, ip, context()); const current = token();
  await expect(service.complete("reset-password", old, ip, context(), newPassword)).rejects.toMatchObject({ code: "BAD_REQUEST" });
  await service.complete("reset-password", current, ip, context(), newPassword);
});

it("changes the password, invalidates every browser and rejects replay atomically", async () => {
  const connection = await fixture.manager.get();
  const user = (await getUserModel(connection).findOne())!;
  const sessionService = createSessionService(connection, APPROVED_SESSION_POLICY);
  const session = await runTransaction(connection, (transaction) => sessionService.issue(transaction,
    { userId: user._id.toHexString(), sessionVersion: 0, authorizationVersion: 0 }, new Date(Date.now() + 60_000)));
  await service.request("reset-password", email, ip, context()); const credential = token();
  await service.complete("reset-password", credential, ip, context(), newPassword);
  const updated = (await getUserModel(connection).findOne().select("+passwordHash"))!;
  expect((await verifyPassword(newPassword, updated.passwordHash)).verified).toBe(true);
  expect(updated.sessionVersion).toBe(1);
  expect(await sessionService.resolve(session.token)).toBeNull();
  expect(await connection.db!.collection("sessions").countDocuments({ revokedAt: { $exists: false } })).toBe(0);
  await expect(service.complete("reset-password", credential, ip, context(), newPassword)).rejects.toMatchObject({ code: "BAD_REQUEST" });
});

it("verifies only pending accounts and never issues a session or membership", async () => {
  const connection = await fixture.manager.get();
  await getUserModel(connection).updateOne({}, { $set: { status: "pending_verification" }, $unset: { verifiedAt: 1 } });
  await service.request("verify-email", email, ip, context());
  const record = (await connection.db!.collection("authActionTokens").findOne())!;
  expect(record.expiresAt.getTime() - record.createdAt.getTime()).toBeGreaterThan(23 * 60 * 60_000);
  await expect(service.complete("reset-password", token(), ip, context(), newPassword)).rejects.toMatchObject({ code: "BAD_REQUEST" });
  await service.complete("verify-email", token(), ip, context());
  expect(await getUserModel(connection).findOne().lean()).toMatchObject({ status: "active", verifiedAt: expect.any(Date) });
  expect(await connection.db!.collection("sessions").countDocuments()).toBe(0);
});

it("rejects changed account state/version and password reuse without consuming the link", async () => {
  const connection = await fixture.manager.get();
  await service.request("reset-password", email, ip, context()); const credential = token();
  await expect(service.complete("reset-password", credential, ip, context(), oldPassword)).rejects.toMatchObject({ code: "BAD_REQUEST" });
  await getUserModel(connection).updateOne({}, { $inc: { sessionVersion: 1 } });
  await expect(service.complete("reset-password", credential, ip, context(), newPassword)).rejects.toMatchObject({ code: "BAD_REQUEST" });
  expect(await connection.db!.collection("authActionTokens").countDocuments({ consumedAt: { $exists: false } })).toBe(1);
});

it("rolls back password, token and sessions when audit fails", async () => {
  const connection = await fixture.manager.get();
  await service.request("reset-password", email, ip, context()); const credential = token();
  await connection.db!.command({ collMod: "auditEvents", validator: { $expr: { $eq: [1, 0] } } });
  await expect(service.complete("reset-password", credential, ip, context(), newPassword)).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
  expect(await getUserModel(connection).findOne().select("+passwordHash").lean()).toMatchObject({ passwordHash, sessionVersion: 0 });
  expect(await connection.db!.collection("authActionTokens").countDocuments({ consumedAt: { $exists: false } })).toBe(1);
  await connection.db!.command({ collMod: "auditEvents", validator: validators.auditEvents });
  await service.complete("reset-password", credential, ip, context(), newPassword);
});

it("fails closed on delivery failure and never sends from a rolled-back issuance", async () => {
  const connection = await fixture.manager.get();
  await connection.db!.command({ collMod: "auditEvents", validator: { $expr: { $eq: [1, 0] } } });
  await expect(service.request("reset-password", email, ip, context())).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
  expect(send).not.toHaveBeenCalled();
  expect(await connection.db!.collection("authActionTokens").countDocuments()).toBe(0);
  await connection.db!.command({ collMod: "auditEvents", validator: validators.auditEvents });
  send.mockRejectedValueOnce(new Error("private transport detail"));
  await expect(service.request("reset-password", email, ip, context())).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
});

it("limits completion attempts before token lookup and keeps purpose budgets separate", async () => {
  for (let attempt = 0; attempt < 30; attempt++) await limiter.checkCompletion("reset-password", ip);
  await expect(service.complete("reset-password", "invalid", ip, context(), newPassword)).rejects.toMatchObject({ code: "RATE_LIMITED" });
  await expect(limiter.checkCompletion("verify-email", ip)).resolves.toBeUndefined();
});

it("serializes concurrent reissue and allows only one reset completion", async () => {
  await Promise.all([service.request("reset-password", email, ip, context()), service.request("reset-password", email, ip, context())]);
  const connection = await fixture.manager.get();
  const outstanding = await connection.db!.collection("authActionTokens").find({ consumedAt: { $exists: false } }).toArray();
  expect(outstanding).toHaveLength(1);
  const candidates = send.mock.calls.map((call) => new URL(call[0].url).hash.slice("#token=".length));
  const current = candidates.find((candidate) => hashActionToken("reset-password", candidate) === outstanding[0]!.tokenHash)!;
  const results = await Promise.allSettled([service.complete("reset-password", current, ip, context(), newPassword), service.complete("reset-password", current, ip, context(), newPassword)]);
  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  expect(await connection.db!.collection("auditEvents").countDocuments({ action: "auth.passwordReset" })).toBe(1);
});

it("shares the approved request budget across verification and recovery", async () => {
  await service.request("verify-email", email, ip, context());
  await service.request("reset-password", email, ip, context());
  await service.request("verify-email", email, ip, context());
  await expect(service.request("reset-password", email, ip, context())).rejects.toMatchObject({ code: "RATE_LIMITED" });
});

it("refuses a newly suspended account without consuming its token", async () => {
  const connection = await fixture.manager.get();
  await service.request("reset-password", email, ip, context());
  await getUserModel(connection).updateOne({}, { $set: { status: "suspended" } });
  await expect(service.complete("reset-password", token(), ip, context(), newPassword)).rejects.toMatchObject({ code: "BAD_REQUEST" });
  expect(await connection.db!.collection("authActionTokens").countDocuments({ consumedAt: { $exists: false } })).toBe(1);
});

it("uses the same guarded orchestration through the configured local provider factory", async () => {
  const connection = await fixture.manager.get();
  vi.stubEnv("NODE_ENV", "development"); vi.stubEnv("LIBRARYOS_LOCAL_HTTPS", "1");
  vi.stubEnv("AUTH_ORIGIN", "https://127.0.0.1:3102");
  vi.stubEnv("AUTH_CSRF_KEY", "ab".repeat(32)); vi.stubEnv("AUTH_RATE_LIMIT_KEY", "cd".repeat(32));
  try {
    const local = await createLocalRecoveryService(connection, limiter, { kind: "gmail-smtp", ready, send },
      createNewPasswordValidator(["a compromised test phrase"]));
    expect(ready).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled();
    await local.request("reset-password", email, ip, context());
    await local.complete("reset-password", token(), ip, context(), newPassword);
    expect(await connection.db!.collection("auditEvents").countDocuments({ action: "auth.passwordReset" })).toBe(1);
  } finally { vi.unstubAllEnvs(); }
});
