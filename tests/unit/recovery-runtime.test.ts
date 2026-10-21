import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ config: vi.fn(), mail: vi.fn(), blocklist: vi.fn(), connection: vi.fn(), infrastructure: vi.fn(),
  identity: vi.fn(), sessions: vi.fn(), limiter: vi.fn(), delivery: vi.fn(), close: vi.fn(), service: vi.fn(), ready: vi.fn(), send: vi.fn() }));
vi.mock("@/server/auth-config", () => ({ readLocalAuthConfiguration: mocks.config }));
vi.mock("@/server/mail-config", () => ({ readGmailConfiguration: mocks.mail }));
vi.mock("@/modules/auth/password-blocklist", () => ({ loadPasswordBlocklist: mocks.blocklist }));
vi.mock("@/server/db/connection", () => ({ getDatabaseConnection: mocks.connection }));
vi.mock("@/server/db/storage-contract", () => ({ verifyInfrastructure: mocks.infrastructure }));
vi.mock("@/modules/auth/identity-storage", () => ({ verifyUserIdentity: mocks.identity }));
vi.mock("@/modules/auth/session-storage", () => ({ verifySessions: mocks.sessions }));
vi.mock("@/server/security/rate-limit", () => ({ createMongoRateLimiter: mocks.limiter }));
vi.mock("@/modules/notifications/gmail-recovery", () => ({ createGmailRecoveryDelivery: mocks.delivery }));
vi.mock("@/modules/auth/recovery-service", () => ({ createLocalRecoveryService: mocks.service }));
beforeEach(() => {
  vi.resetModules(); Object.values(mocks).forEach((mock) => mock.mockReset());
  mocks.config.mockReturnValue({ limiterKey: Buffer.alloc(32) });
  mocks.mail.mockReturnValue({}); mocks.blocklist.mockReturnValue({ validate: () => "fixture" });
  mocks.connection.mockResolvedValue({}); mocks.limiter.mockResolvedValue({});
  mocks.delivery.mockReturnValue({ kind: "gmail-smtp", close: mocks.close, ready: mocks.ready, send: mocks.send });
  mocks.service.mockResolvedValue({ request: "fixture" });
});

it("shares concurrent initialization and verifies prerequisites without SMTP activity", async () => {
  const { getLocalRecoveryService } = await import("@/server/recovery-runtime");
  const results = await Promise.all([getLocalRecoveryService(), getLocalRecoveryService()]);
  expect(results[0]).toBe(results[1]);
  for (const key of ["mail", "blocklist", "connection", "infrastructure", "identity", "sessions", "limiter", "delivery", "service"] as const) expect(mocks[key]).toHaveBeenCalledOnce();
  expect(mocks.ready).not.toHaveBeenCalled(); expect(mocks.send).not.toHaveBeenCalled();
});

it.each(["mail", "blocklist"] as const)("fails before database access on missing %s and retries after repair", async (dependency) => {
  const { getLocalRecoveryService } = await import("@/server/recovery-runtime");
  mocks[dependency].mockImplementationOnce(() => { throw new Error("private configuration detail"); });
  await expect(getLocalRecoveryService()).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
  expect(mocks.connection).not.toHaveBeenCalled();
  await expect(getLocalRecoveryService()).resolves.toEqual({ request: "fixture" });
});

it("closes failed service initialization and permits a later retry", async () => {
  const { getLocalRecoveryService } = await import("@/server/recovery-runtime");
  mocks.service.mockRejectedValueOnce(new Error("missing action-token storage"));
  await expect(getLocalRecoveryService()).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
  expect(mocks.close).toHaveBeenCalledOnce();
  await expect(getLocalRecoveryService()).resolves.toEqual({ request: "fixture" });
});

it("rechecks the local environment even when an initialization promise exists", async () => {
  const { getLocalRecoveryService } = await import("@/server/recovery-runtime");
  await getLocalRecoveryService();
  mocks.config.mockImplementation(() => { throw new Error("hosted/production target"); });
  await expect(getLocalRecoveryService()).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
});
