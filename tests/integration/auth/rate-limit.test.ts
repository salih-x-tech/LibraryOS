import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { startIsolatedDatabase } from "../helpers/database";
import { createDatabaseConnectionManager } from "@/server/db/connection";
import { createMongoRateLimiter } from "@/server/security/rate-limit";
import { ATTEMPT_COLLECTION, BUCKET_COLLECTION, verifyRateLimitStorage } from "@/server/security/rate-limit-contract";
import { deployRateLimitStorage } from "../../../scripts/db/rate-limit";
import { RateLimitError } from "@/server/http/errors";
import { createRequestContext, errorResponse } from "@/server/http/responses";

let fixture: Awaited<ReturnType<typeof startIsolatedDatabase>>;
const secret = Buffer.alloc(32, 7); // fixture only; no application key read
beforeAll(async () => { fixture = await startIsolatedDatabase(); });
beforeEach(async () => {
  await fixture.clear();
  await deployRateLimitStorage(await fixture.manager.get());
});
afterAll(async () => { await fixture?.stop(); });
async function limiter() { return createMongoRateLimiter(await fixture.manager.get(), secret); }

describe("MongoDB distributed authentication limiter", () => {
  it("caps concurrent login account reservations across independent pools", async () => {
    const connection = await fixture.manager.get();
    const manager = createDatabaseConnectionManager({
      uri: `mongodb://127.0.0.1:${connection.port}/`, databaseName: fixture.databaseName,
    });
    try {
      const first = await limiter();
      const second = await createMongoRateLimiter(await manager.get(), secret);
      const results = await Promise.allSettled(Array.from({ length: 10 }, (_, index) =>
        (index % 2 ? first : second).beginLogin("student@example.com", `192.0.2.${index + 1}`)));
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(5);
      for (const result of results) if (result.status === "rejected") expect(result.reason).toBeInstanceOf(RateLimitError);
      const records = await connection.db!.collection(BUCKET_COLLECTION).find({ kind: "login.account" }).toArray();
      expect(records).toHaveLength(1);
      expect(records[0]?.count).toBe(5);
      expect(await connection.db!.collection(ATTEMPT_COLLECTION).countDocuments()).toBe(5);
    } finally { await manager.close(); }
  });
  it("retains failed attempts, releases successful ones exactly once and cannot undo a recorded failure", async () => {
    const service = await limiter();
    const permits = [];
    for (let i = 0; i < 5; i++) permits.push(await service.beginLogin("student@example.com", `192.0.2.${i + 1}`));
    await expect(service.beginLogin("student@example.com", "192.0.2.99")).rejects.toBeInstanceOf(RateLimitError);
    await Promise.all([permits[0]!.complete("success"), permits[0]!.complete("success")]);
    const replacement = await service.beginLogin("student@example.com", "192.0.2.100");
    await replacement.complete("failure");
    await replacement.complete("success");
    await expect(service.beginLogin("student@example.com", "192.0.2.101")).rejects.toBeInstanceOf(RateLimitError);
    const record = await (await fixture.manager.get()).db!.collection(BUCKET_COLLECTION).findOne({ kind: "login.account" });
    expect(record?.count).toBe(5);
  });
  it("blocks after five completed failures and does not allow a caller to refund them", async () => {
    const service = await limiter();
    for (let i = 0; i < 5; i++) {
      const permit = await service.beginLogin("student@example.com", "192.0.2.1");
      await permit.complete("failure");
    }
    await expect(service.beginLogin("student@example.com", "192.0.2.2")).rejects.toBeInstanceOf(RateLimitError);
    expect(await (await fixture.manager.get()).db!.collection(ATTEMPT_COLLECTION).countDocuments({ status: "failure" })).toBe(5);
  });
  it("atomically caps a burst against a shared IP without charging rejected requests above the cap", async () => {
    const service = await limiter();
    const results = await Promise.allSettled(Array.from({ length: 12 }, (_, i) =>
      service.checkRequest("registration", `student${i}@example.com`, "192.0.2.200")));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(5);
    for (const result of results) if (result.status === "rejected") expect(result.reason).toBeInstanceOf(RateLimitError);
    expect(await (await fixture.manager.get()).db!.collection(BUCKET_COLLECTION).findOne({ kind: "registration.ip" })).toMatchObject({ count: 5 });
  });
  it("allows repeated successful logins while still enforcing all IP attempts", async () => {
    const service = await limiter();
    for (let i = 0; i < 30; i++) {
      const permit = await service.beginLogin("student@example.com", "192.0.2.1");
      await permit.complete("success");
    }
    await expect(service.beginLogin("student@example.com", "192.0.2.1")).rejects.toMatchObject({ code: "RATE_LIMITED" });
  });
  it("shares normalized email and IP limits while separating actions and subjects", async () => {
    const service = await limiter();
    for (let i = 0; i < 3; i++) await service.checkRequest("recovery", " Student@Example.COM ", `192.0.2.${i + 1}`);
    await expect(service.checkRequest("recovery", "student@example.com", "192.0.2.55")).rejects.toBeInstanceOf(RateLimitError);
    await expect(service.checkRequest("registration", "student@example.com", "192.0.2.55")).resolves.toBeUndefined();
    for (let i = 0; i < 5; i++) await service.checkRequest("recovery", `other${i}@example.com`, i % 2 ? "::ffff:192.0.2.200" : "192.0.2.200");
    await expect(service.checkRequest("recovery", "fresh@example.com", "192.0.2.200")).rejects.toBeInstanceOf(RateLimitError);
  });
  it("resets expired windows without waiting for TTL and prevents late success crediting the new window", async () => {
    const service = await limiter();
    const old = await service.beginLogin("student@example.com", "192.0.2.1");
    const db = (await fixture.manager.get()).db!;
    await db.collection(BUCKET_COLLECTION).updateMany({}, { $set: { expiresAt: new Date(Date.now() - 1) } });
    await service.beginLogin("student@example.com", "192.0.2.2");
    await old.complete("success");
    expect(await db.collection(BUCKET_COLLECTION).findOne({ kind: "login.account" })).toMatchObject({ count: 1 });
  });
  it("stores no raw email/IP and returns Retry-After with generic rate-limit errors", async () => {
    const service = await limiter();
    for (let i = 0; i < 3; i++) await service.checkRequest("registration", "private@example.com", "192.0.2.90");
    try {
      await service.checkRequest("registration", "private@example.com", "192.0.2.90");
      expect.fail("Expected limit");
    } catch (error) {
      const response = errorResponse(error, createRequestContext());
      expect(response.status).toBe(429);
      expect(Number(response.headers.get("retry-after"))).toBeGreaterThan(0);
      expect(await response.text()).not.toMatch(/private|192\.0\.2/);
    }
    const db = (await fixture.manager.get()).db!;
    expect(JSON.stringify(await db.collection(BUCKET_COLLECTION).find().toArray())).not.toMatch(/private|192\.0\.2/);
  });
  it("refuses missing/drifted deployment and fails closed on store errors", async () => {
    const connection = await fixture.manager.get();
    await deployRateLimitStorage(connection);
    await verifyRateLimitStorage(connection);
    const service = await limiter();
    const session = vi.spyOn(connection, "transaction").mockRejectedValueOnce(new Error("private storage error"));
    await expect(service.beginLogin("student@example.com", "192.0.2.1")).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
    session.mockRestore();
    await connection.db!.collection(BUCKET_COLLECTION).dropIndex("rate_limit_expiry");
    await expect(createMongoRateLimiter(connection, secret)).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
    await deployRateLimitStorage(connection);
    await expect(connection.db!.collection(BUCKET_COLLECTION).insertOne({ rawEmail: "private@example.com" })).rejects.toMatchObject({ code: 121 });
  });
});
