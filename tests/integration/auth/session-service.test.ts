import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Types } from "mongoose";
import { startIsolatedDatabase } from "../helpers/database";
import { deploySessions } from "../../../scripts/db/sessions";
import { deployUserIdentity } from "../../../scripts/db/identity";
import { hashPassword } from "@/modules/auth/passwords";
import { getUserModel } from "@/modules/auth/user-model";
import { getSessionModel } from "@/modules/auth/session-model";
import { createSessionService } from "@/modules/auth/session-service";
import { createSessionCredential } from "@/modules/auth/sessions";
import { runTransaction } from "@/server/db/transaction";
import { createCsrfProtection } from "@/server/security/csrf";
import { APPROVED_SESSION_POLICY, SESSION_IDLE_TIMEOUT_MS, SESSION_LIFETIME_MS } from "@/modules/auth/session-policy";

let fixture: Awaited<ReturnType<typeof startIsolatedDatabase>>;
let passwordHash: string;
const userId = new Types.ObjectId();
const identity = { userId: userId.toHexString(), sessionVersion: 0, authorizationVersion: 0 };
const policy = { allowedUserStatuses: ["fixture_active"], requireVerifiedEmail: true }; // test policy only
const deadline = () => new Date(Date.now() + 60_000);
beforeAll(async () => { passwordHash = await hashPassword("Synthetic fixture secret 42!"); fixture = await startIsolatedDatabase(); });
beforeEach(async () => {
  await fixture.clear();
  const connection = await fixture.manager.get();
  await deployUserIdentity(connection);
  await deploySessions(connection);
  await getUserModel(connection).create({ _id: userId, normalizedEmail: "fixture@example.com", passwordHash,
    status: "fixture_active", verifiedAt: new Date(), sessionVersion: 0, authorizationVersion: 0, operationFence: 0 });
});
afterAll(async () => { await fixture?.stop(); });

async function setup() {
  const connection = await fixture.manager.get();
  const service = createSessionService(connection, policy);
  const issued = await runTransaction(connection, (context) => service.issue(context, identity, deadline()));
  return { connection, service, issued };
}

describe("current-user session lifecycle", () => {
  it("enforces approved active/verified login state without exposing public registration", async () => {
    const connection = await fixture.manager.get();
    const service = createSessionService(connection, APPROVED_SESSION_POLICY);
    await expect(runTransaction(connection, (context) => service.issue(context, identity, deadline()))).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    await getUserModel(connection).updateOne({}, { $set: { status: "active" } });
    const issued = await runTransaction(connection, (context) => service.issue(context, identity, deadline()));
    expect(await service.resolve(issued.token)).toMatchObject(identity);
    await getUserModel(connection).updateOne({}, { $unset: { verifiedAt: 1 } });
    expect(await service.resolve(issued.token)).toBeNull();
  });
  it("expires idle browser sessions and never revives them on read or rotation", async () => {
    const { service, connection, issued } = await setup();
    const old = new Date(Date.now() - SESSION_IDLE_TIMEOUT_MS - 1000);
    await connection.db!.collection("sessions").updateOne({}, { $set: { lastSeenAt: old } });
    expect(await service.resolve(issued.token)).toBeNull();
    await expect(runTransaction(connection, (context) => service.rotate(context, issued.token, deadline()))).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    expect(await connection.db!.collection("sessions").findOne()).toMatchObject({ lastSeenAt: old });
  });
  it("caps absolute lifetime, updates activity and preserves the original deadline through rotation", async () => {
    const connection = await fixture.manager.get();
    const service = createSessionService(connection, policy);
    const issued = await runTransaction(connection, (context) => service.issue(context, identity, new Date(Date.now() + SESSION_LIFETIME_MS * 2)));
    const original = (await connection.db!.collection("sessions").findOne())!;
    expect(original.expiresAt.getTime() - original.startedAt.getTime()).toBe(SESSION_LIFETIME_MS);
    const earlierActivity = new Date(Date.now() - 60_000);
    await connection.db!.collection("sessions").updateOne({}, { $set: { lastSeenAt: earlierActivity } });
    await service.resolve(issued.token);
    expect((await connection.db!.collection("sessions").findOne())!.lastSeenAt.getTime()).toBeGreaterThan(earlierActivity.getTime());
    const rotated = await runTransaction(connection, (context) => service.rotate(context, issued.token, new Date(Date.now() + SESSION_LIFETIME_MS * 2)));
    expect(rotated.expiresAt).toEqual(original.expiresAt);
    const stored = (await connection.db!.collection("sessions").findOne({ revokedAt: { $exists: false } }))!;
    expect(stored.familyId).toEqual(original.familyId);
    expect(stored.startedAt).toEqual(original.startedAt);
  });
  it("logs out a browser family using an already-rotated token without logging out another browser", async () => {
    const { service, connection, issued } = await setup();
    const otherBrowser = await runTransaction(connection, (context) => service.issue(context, identity, deadline()));
    const rotated = await runTransaction(connection, (context) => service.rotate(context, issued.token, deadline()));
    await runTransaction(connection, (context) => service.revoke(context, issued.token));
    expect(await service.resolve(rotated.token)).toBeNull();
    expect(await service.resolve(otherBrowser.token)).toMatchObject(identity);
  });
  it("serializes logout against rotation so no replacement from that browser remains valid", async () => {
    const { service, connection, issued } = await setup();
    const [rotation, logout] = await Promise.allSettled([
      runTransaction(connection, (context) => service.rotate(context, issued.token, deadline())),
      runTransaction(connection, (context) => service.revoke(context, issued.token)),
    ]);
    expect(logout.status).toBe("fulfilled");
    if (rotation.status === "fulfilled") expect(await service.resolve(rotation.value.token)).toBeNull();
    expect(await service.resolve(issued.token)).toBeNull();
  });
  it("evicts the oldest browser on the fourth login and enforces the cap under parallel issuance", async () => {
    const { service, connection, issued } = await setup();
    // Give the first browser a strictly earlier start, independent of timer precision.
    await connection.db!.collection("sessions").updateOne({}, { $set: { startedAt: new Date(Date.now() - 1000) } });
    for (let index = 0; index < 3; index++) await runTransaction(connection, (context) => service.issue(context, identity, deadline()));
    expect(await service.resolve(issued.token)).toBeNull();
    await Promise.all(Array.from({ length: 4 }, () => runTransaction(connection, (context) => service.issue(context, identity, deadline()))));
    expect(await getSessionModel(connection).countDocuments({ revokedAt: { $exists: false } })).toBe(3);
  });
  it("rolls back browser eviction if the new login transaction aborts", async () => {
    const { service, connection, issued } = await setup();
    for (let index = 0; index < 2; index++) await runTransaction(connection, (context) => service.issue(context, identity, deadline()));
    await expect(runTransaction(connection, async (context) => {
      await service.issue(context, identity, deadline());
      throw new Error("synthetic abort after eviction");
    })).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
    expect(await service.resolve(issued.token)).toMatchObject(identity);
    expect(await getSessionModel(connection).countDocuments({ revokedAt: { $exists: false } })).toBe(3);
  });
  it("binds CSRF checks to a freshly resolved session through rotation and revocation", async () => {
    const { connection, service, issued } = await setup();
    const origin = "https://libraryos.example";
    const csrf = createCsrfProtection({ origin, secret: Buffer.alloc(32, 1) });
    const initial = (await service.resolve(issued.token))!;
    const oldCsrf = csrf.issue(initial);
    const request = (token: string) => ({ method: "POST", headers: new Headers({
      Origin: origin, "Content-Type": "application/json", "X-CSRF-Token": token,
    }) });
    expect(() => csrf.assertMutation(request(oldCsrf), initial)).not.toThrow();
    const replacement = await runTransaction(connection, (context) => service.rotate(context, issued.token, deadline()));
    const revoked = await service.resolve(issued.token);
    expect(() => csrf.assertMutation(request(oldCsrf), revoked)).toThrow("Authentication is required.");
    const current = (await service.resolve(replacement.token))!;
    expect(() => csrf.assertMutation(request(oldCsrf), current)).toThrow("Access is denied.");
    const freshCsrf = csrf.issue(current);
    expect(() => csrf.assertMutation(request(freshCsrf), current)).not.toThrow();
    await runTransaction(connection, (context) => service.revokeAll(context, identity));
    const afterRevocation = await service.resolve(replacement.token);
    expect(afterRevocation).toBeNull();
    expect(() => csrf.assertMutation(request(freshCsrf), afterRevocation)).toThrow("Authentication is required.");
  });
  it("resolves only safe global identity/version fields without tenant grants or credentials", async () => {
    const { service, issued } = await setup();
    const principal = await service.resolve(issued.token);
    expect(principal).toEqual({ ...identity, sessionId: expect.any(String) });
    expect(Object.isFrozen(principal)).toBe(true);
    expect(await service.resolve("invalid")).toBeNull();
    expect(await service.resolve(createSessionCredential().token)).toBeNull();
  });
  it("checks expiry without relying on asynchronous TTL cleanup", async () => {
    const { service, issued, connection } = await setup();
    await getSessionModel(connection).updateOne({}, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    expect(await service.resolve(issued.token)).toBeNull();
    await expect(runTransaction(connection, (context) => service.rotate(context, issued.token, deadline()))).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
  });
  it("rejects revoked sessions and repeated logout safely", async () => {
    const { service, issued, connection } = await setup();
    await runTransaction(connection, (context) => service.revoke(context, issued.token));
    await runTransaction(connection, (context) => service.revoke(context, issued.token));
    expect(await service.resolve(issued.token)).toBeNull();
    await expect(runTransaction(connection, (context) => service.rotate(context, issued.token, deadline()))).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
  });
  it("rechecks user state, verification and version on every read", async () => {
    const { service, issued, connection } = await setup();
    const users = getUserModel(connection);
    await users.updateOne({}, { $set: { status: "fixture_suspended" } });
    expect(await service.resolve(issued.token)).toBeNull();
    await users.updateOne({}, { $set: { status: "fixture_active" }, $unset: { verifiedAt: 1 } });
    expect(await service.resolve(issued.token)).toBeNull();
    await users.updateOne({}, { $set: { verifiedAt: new Date(), sessionVersion: 1 } });
    expect(await service.resolve(issued.token)).toBeNull();
    await users.deleteOne({});
    expect(await service.resolve(issued.token)).toBeNull();
  });
  it("atomically rotates and rejects replay of the old credential", async () => {
    const { service, issued, connection } = await setup();
    const next = await runTransaction(connection, (context) => service.rotate(context, issued.token, deadline()));
    expect(next.token).not.toBe(issued.token);
    expect(await service.resolve(issued.token)).toBeNull();
    expect(await service.resolve(next.token)).toMatchObject(identity);
    await expect(runTransaction(connection, (context) => service.rotate(context, issued.token, deadline()))).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
  });
  it("rolls back rotation and old-token revocation together", async () => {
    const { service, issued, connection } = await setup();
    await expect(runTransaction(connection, async (context) => {
      await service.rotate(context, issued.token, deadline());
      throw new Error("synthetic abort");
    })).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
    expect(await service.resolve(issued.token)).toMatchObject(identity);
    expect(await getSessionModel(connection).countDocuments()).toBe(1);
  });
  it("allows only one of two competing rotations to succeed", async () => {
    const { service, issued, connection } = await setup();
    const results = await Promise.allSettled(Array.from({ length: 2 }, () => runTransaction(connection, (context) => service.rotate(context, issued.token, deadline()))));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(await getSessionModel(connection).countDocuments({ revokedAt: { $exists: false } })).toBe(1);
  });
  it("revokes all sessions and prevents stale verified reads from issuing new ones", async () => {
    const { service, issued, connection } = await setup();
    const other = await runTransaction(connection, (context) => service.issue(context, identity, deadline()));
    await runTransaction(connection, (context) => service.revokeAll(context, identity));
    expect(await service.resolve(issued.token)).toBeNull();
    expect(await service.resolve(other.token)).toBeNull();
    await expect(runTransaction(connection, (context) => service.issue(context, identity, deadline()))).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    expect(await getUserModel(connection).findById(userId).lean()).toMatchObject({ sessionVersion: 1 });
  });
  it("serializes concurrent issuance with revoke-all so no old-version session remains valid", async () => {
    const { service, issued, connection } = await setup();
    const [issuance, revocation] = await Promise.allSettled([
      runTransaction(connection, (context) => service.issue(context, identity, deadline())),
      runTransaction(connection, (context) => service.revokeAll(context, identity)),
    ]);
    expect(revocation.status).toBe("fulfilled");
    if (issuance.status === "fulfilled") expect(await service.resolve(issuance.value.token)).toBeNull();
    expect(await service.resolve(issued.token)).toBeNull();
  });
  it("fails closed on stale authorization, unapproved user states and invalid expiry", async () => {
    const { service, connection, issued } = await setup();
    await getUserModel(connection).updateOne({}, { $inc: { authorizationVersion: 1 } });
    expect(await service.resolve(issued.token)).toMatchObject({ authorizationVersion: 1 });
    await expect(runTransaction(connection, (context) => service.issue(context, identity, deadline()))).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    await getUserModel(connection).updateOne({}, { $set: { status: "fixture_suspended" } });
    await expect(runTransaction(connection, (context) => service.issue(context, { ...identity, authorizationVersion: 1 }, deadline()))).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    await expect(runTransaction(connection, (context) => service.issue(context, identity, new Date(0)))).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
    const session = await connection.startSession();
    try { await expect(service.revoke({ session }, createSessionCredential().token)).rejects.toThrow("active transaction"); }
    finally { await session.endSession(); }
  });
  it("snapshots explicit policy inputs rather than trusting later caller mutation", async () => {
    const { issued, connection } = await setup();
    const mutablePolicy = { allowedUserStatuses: ["fixture_active"], requireVerifiedEmail: true };
    const service = createSessionService(connection, mutablePolicy);
    mutablePolicy.allowedUserStatuses[0] = "fixture_suspended";
    mutablePolicy.requireVerifiedEmail = false;
    expect(await service.resolve(issued.token)).toMatchObject(identity);
    await getUserModel(connection).updateOne({}, { $unset: { verifiedAt: 1 } });
    expect(await service.resolve(issued.token)).toBeNull();
    const explicitUnverifiedPolicy = createSessionService(connection, { allowedUserStatuses: ["fixture_active"], requireVerifiedEmail: false });
    expect(await explicitUnverifiedPolicy.resolve(issued.token)).toMatchObject(identity);
  });
  it("rolls back global version invalidation together with session revocations", async () => {
    const { issued, connection, service } = await setup();
    await expect(runTransaction(connection, async (context) => {
      await service.revokeAll(context, identity);
      throw new Error("synthetic abort");
    })).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
    expect(await service.resolve(issued.token)).toMatchObject(identity);
    expect(await getUserModel(connection).findById(userId).lean()).toMatchObject({ sessionVersion: 0 });
  });
  it("sanitizes lookup failures without treating an outage as a valid or anonymous session", async () => {
    const { issued, connection, service } = await setup();
    vi.spyOn(getSessionModel(connection), "findOne").mockImplementationOnce(() => { throw new Error("private-database-detail"); });
    try {
      await service.resolve(issued.token);
      expect.fail("Expected lookup failure");
    } catch (error) {
      expect(error).toMatchObject({ code: "SERVICE_UNAVAILABLE" });
      expect(error).not.toHaveProperty("cause");
      expect(String(error)).not.toContain("private-database-detail");
    }
  });
  it("copies identity inputs before asynchronous guarded writes", async () => {
    const connection = await fixture.manager.get();
    const service = createSessionService(connection, policy);
    const issued = await runTransaction(connection, async (context) => {
      const mutable = { ...identity };
      const pending = service.issue(context, mutable, deadline());
      mutable.userId = new Types.ObjectId().toHexString();
      return pending;
    });
    expect(await service.resolve(issued.token)).toMatchObject(identity);
    await runTransaction(connection, async (context) => {
      const mutable = { ...identity };
      const pending = service.revokeAll(context, mutable);
      mutable.userId = new Types.ObjectId().toHexString();
      await pending;
    });
    expect(await service.resolve(issued.token)).toBeNull();
    expect(await getSessionModel(connection).countDocuments({ revokedAt: { $exists: false } })).toBe(0);
  });
});
