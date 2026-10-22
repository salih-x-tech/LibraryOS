import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { startIsolatedDatabase } from "../helpers/database";
import { deployInfrastructure } from "../../../scripts/db/indexes";
import { deployRecoveryRequests } from "../../../scripts/db/recovery-requests";
import { deployRateLimitStorage } from "../../../scripts/db/rate-limit";
import { createMongoRateLimiter } from "@/server/security/rate-limit";
import { createRecoveryRequestQueue } from "@/modules/auth/recovery-requests";
import { createRecoveryRequestCipher } from "@/modules/auth/recovery-request-crypto";
import { verifyRecoveryRequests } from "@/modules/auth/recovery-request-storage";
import { createRequestContext } from "@/server/http/responses";
import { validators } from "@/server/db/validators";

let fixture: Awaited<ReturnType<typeof startIsolatedDatabase>>;
let queue: Awaited<ReturnType<typeof createRecoveryRequestQueue>>;
const key = Buffer.alloc(32, 9);
beforeAll(async () => { fixture = await startIsolatedDatabase(); });
beforeEach(async () => {
  await fixture.clear(); const connection = await fixture.manager.get();
  await deployInfrastructure(connection); await deployRecoveryRequests(connection); await deployRateLimitStorage(connection);
  queue = await createRecoveryRequestQueue(connection, await createMongoRateLimiter(connection, Buffer.alloc(32, 10)), key);
});
afterAll(async () => { await fixture?.stop(); });

it("atomically records encrypted intent and audit without identity/token/provider storage", async () => {
  const context = createRequestContext();
  await expect(queue.enqueue("reset-password", " Reader@Example.com ", "192.0.2.1", context)).resolves.toBeUndefined();
  const db = (await fixture.manager.get()).db!;
  const record = (await db.collection("authRecoveryRequests").findOne())!;
  expect(record).toMatchObject({ status: "pending", requestId: context.requestId });
  expect(createRecoveryRequestCipher(key).open({ ciphertext: record.ciphertext, nonce: record.nonce, tag: record.tag }, "reset-password", context.requestId)).toBe("reader@example.com");
  expect(JSON.stringify(record)).not.toMatch(/reader@example|token|passwordHash/);
  expect(JSON.stringify(await db.collection("auditEvents").find().toArray())).not.toContain("reader@example.com");
  expect(await db.listCollections({ name: "users" }).hasNext()).toBe(false);
  expect(await db.listCollections({ name: "authActionTokens" }).hasNext()).toBe(false);
});

it("records identical intent shapes regardless of account existence or eligibility", async () => {
  const db = (await fixture.manager.get()).db!;
  // Deliberately unrelated sentinel documents; admission must never read them.
  await db.collection("users").insertMany([{ normalizedEmail: "known@example.com", status: "active" }, { normalizedEmail: "blocked@example.com", status: "suspended" }]);
  for (const email of ["known@example.com", "blocked@example.com", "unknown@example.com"]) {
    await expect(queue.enqueue("verify-email", email, "192.0.2.1", createRequestContext())).resolves.toBeUndefined();
  }
  const records = await db.collection("authRecoveryRequests").find().toArray();
  expect(records).toHaveLength(3);
  expect(new Set(records.map((record) => Object.keys(record).sort().join(","))).size).toBe(1);
  expect(records.every((record) => record.ciphertext.length === 2048)).toBe(true);
});

it("rolls back intent when mandatory audit persistence fails", async () => {
  const db = (await fixture.manager.get()).db!;
  await db.command({ collMod: "auditEvents", validator: { $expr: { $eq: [1, 0] } } });
  await expect(queue.enqueue("reset-password", "reader@example.com", "192.0.2.1", createRequestContext())).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
  expect(await db.collection("authRecoveryRequests").countDocuments()).toBe(0);
  await db.command({ collMod: "auditEvents", validator: validators.auditEvents });
});

it("charges the shared account request budget across purposes", async () => {
  for (let index = 0; index < 3; index++) await queue.enqueue(index === 1 ? "verify-email" : "reset-password", "reader@example.com", "192.0.2.1", createRequestContext());
  await expect(queue.enqueue("verify-email", "reader@example.com", "192.0.2.1", createRequestContext())).rejects.toMatchObject({ code: "RATE_LIMITED" });
  expect(await (await fixture.manager.get()).db!.collection("authRecoveryRequests").countDocuments()).toBe(3);
});

it("requires explicit deployment and rejects drift without repairing it", async () => {
  const connection = await fixture.manager.get();
  await deployRecoveryRequests(connection); await verifyRecoveryRequests(connection);
  await connection.db!.collection("authRecoveryRequests").dropIndex("recovery_request_unique");
  await expect(verifyRecoveryRequests(connection)).rejects.toThrow();
  expect(await connection.db!.collection("authRecoveryRequests").indexExists("recovery_request_unique")).toBe(false);
  await fixture.clear();
  await expect(verifyRecoveryRequests(connection)).rejects.toThrow();
  expect(await connection.db!.listCollections().toArray()).toEqual([]);
});

it("database validation refuses plaintext addresses or raw token fields", async () => {
  await queue.enqueue("reset-password", "reader@example.com", "192.0.2.1", createRequestContext());
  const collection = (await fixture.manager.get()).db!.collection("authRecoveryRequests");
  const record = (await collection.findOne())!;
  for (const field of [{ email: "reader@example.com" }, { token: "not-permitted" }]) {
    await expect(collection.updateOne({ _id: record._id }, { $set: field })).rejects.toMatchObject({ code: 121 });
  }
});
