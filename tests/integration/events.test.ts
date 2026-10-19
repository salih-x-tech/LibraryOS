import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Types } from "mongoose";
import { startIsolatedDatabase } from "./helpers/database";
import { runTransaction } from "@/server/db/transaction";
import { createTenantScope } from "@/server/db/scope";
import { appendAudit, type AuditInput } from "@/modules/audit/append";
import { publishOutbox } from "@/modules/notifications/publish";
import { createRequestContext } from "@/server/http/responses";
import { deployInfrastructure } from "../../scripts/db/indexes";

let fixture: Awaited<ReturnType<typeof startIsolatedDatabase>>;
const organizationId = new Types.ObjectId().toHexString();
const resourceId = new Types.ObjectId().toHexString();
const scope = createTenantScope(organizationId);
const audit: AuditInput = {
  scope: { kind: "tenant", organizationId }, actor: { userId: new Types.ObjectId().toHexString() },
  action: "probe.created", resourceType: "probe", resourceId, branchIds: [],
  requestId: createRequestContext().requestId, changedFields: ["status"],
};
const event = { eventType: "probe.created", resourceId, eventKey: "probe.created.once", payload: {} };
beforeAll(async () => { fixture = await startIsolatedDatabase(); });
beforeEach(async () => {
  await fixture.clear();
  const connection = await fixture.manager.get();
  await deployInfrastructure(connection);
  await connection.db!.createCollection("connection_probes");
});
afterAll(async () => { await fixture?.stop(); });

describe("atomic audit and outbox", () => {
  it("keeps events invisible to outside readers until commit", async () => {
    const connection = await fixture.manager.get();
    await runTransaction(connection, async (context) => {
      await connection.db!.collection("connection_probes").insertOne({ value: 1 }, { session: context.session });
      await appendAudit(connection, context, audit);
      await publishOutbox(connection, context, scope, event);
      expect(await connection.db!.collection("outboxEvents").countDocuments()).toBe(0);
      expect(await connection.db!.collection("auditEvents").countDocuments()).toBe(0);
    });
    expect(await connection.db!.collection("auditEvents").countDocuments()).toBe(1);
    expect(await connection.db!.collection("outboxEvents").countDocuments()).toBe(1);
  });
  it("rolls back business writes and both event types together", async () => {
    const connection = await fixture.manager.get();
    await expect(runTransaction(connection, async (context) => {
      await connection.db!.collection("connection_probes").insertOne({ value: 1 }, { session: context.session });
      await appendAudit(connection, context, audit);
      await publishOutbox(connection, context, scope, event);
      throw new Error("synthetic abort");
    })).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
    for (const name of ["auditEvents", "outboxEvents", "connection_probes"]) expect(await connection.db!.collection(name).countDocuments()).toBe(0);
  });
  it("rejects nontransactional append and strips unknown content from inputs", async () => {
    const connection = await fixture.manager.get();
    const session = await connection.startSession();
    try {
      await expect(appendAudit(connection, { session }, audit)).rejects.toThrow("active transaction");
      await expect(publishOutbox(connection, { session }, scope, event)).rejects.toThrow("active transaction");
    } finally { await session.endSession(); }
    await runTransaction(connection, async (context) => {
      await appendAudit(connection, context, { ...audit, scope: { kind: "global" }, actor: { systemIdentity: "test.fixture" } });
      const withExtraContent = { ...event, payload: { recipientUserId: resourceId, secret: "private" } };
      await publishOutbox(connection, context, scope, withExtraContent);
    });
    const stored = await connection.db!.collection("auditEvents").findOne({ scopeKind: "global" });
    expect(stored?.scopeKey).toBe("global");
    expect(stored).not.toHaveProperty("organizationId");
    expect(JSON.stringify(await connection.db!.collection("outboxEvents").findOne())).not.toContain("private");
  });
  it("enforces per-tenant event-key uniqueness without sharing keys between tenants", async () => {
    const connection = await fixture.manager.get();
    await runTransaction(connection, async (context) => { await publishOutbox(connection, context, scope, event); });
    await expect(runTransaction(connection, async (context) => {
      await appendAudit(connection, context, audit);
      await publishOutbox(connection, context, scope, event);
    })).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
    expect(await connection.db!.collection("auditEvents").countDocuments()).toBe(0);
    await runTransaction(connection, async (context) => {
      await publishOutbox(connection, context, createTenantScope(new Types.ObjectId().toHexString()), event);
    });
    expect(await connection.db!.collection("outboxEvents").countDocuments()).toBe(2);
  });
});
