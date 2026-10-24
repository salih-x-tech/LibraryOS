import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ config: vi.fn(), issuer: vi.fn(), connection: vi.fn(), delivery: vi.fn(),
  worker: vi.fn(), lifecycle: vi.fn(), ready: vi.fn(), send: vi.fn(), close: vi.fn() }));
vi.mock("@/server/auth-config", () => ({ readLocalAuthConfiguration: mocks.config }));
vi.mock("@/server/recovery-runtime", () => ({ getLocalRecoveryService: mocks.issuer }));
vi.mock("@/server/db/connection", () => ({ getDatabaseConnection: mocks.connection }));
vi.mock("@/modules/notifications/gmail-recovery", () => ({ createGmailRecoveryDelivery: mocks.delivery }));
vi.mock("@/modules/auth/recovery-delivery-worker", () => ({ createRecoveryDeliveryWorker: mocks.worker }));
vi.mock("@/modules/auth/recovery-request-lifecycle", () => ({ createRecoveryRequestLifecycle: mocks.lifecycle }));
beforeEach(() => {
  vi.resetModules(); Object.values(mocks).forEach((mock) => mock.mockReset());
  mocks.config.mockReturnValue({}); mocks.issuer.mockResolvedValue({}); mocks.connection.mockResolvedValue({});
  mocks.delivery.mockReturnValue({ ready: mocks.ready, send: mocks.send, close: mocks.close });
  mocks.worker.mockResolvedValue({ processOne: "fixture" }); mocks.lifecycle.mockResolvedValue({});
  vi.stubEnv("AUTH_RECOVERY_QUEUE_KEY", "ef".repeat(32)); vi.stubEnv("AUTH_RECOVERY_WORKER", "1");
});
afterEach(() => vi.unstubAllEnvs());
it("requires explicit invocation and switch, and initializes without provider activity", async () => {
  const { getLocalRecoveryWorker } = await import("@/server/recovery-worker-runtime");
  vi.stubEnv("AUTH_RECOVERY_WORKER", "");
  await expect(getLocalRecoveryWorker()).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
  expect(mocks.issuer).not.toHaveBeenCalled();
  vi.stubEnv("AUTH_RECOVERY_WORKER", "1");
  const result = await Promise.all([getLocalRecoveryWorker(), getLocalRecoveryWorker()]);
  expect(result[0]).toBe(result[1]); expect(mocks.worker).toHaveBeenCalledOnce();
  expect(mocks.ready).not.toHaveBeenCalled(); expect(mocks.send).not.toHaveBeenCalled();
});
it("closes failed construction and permits retry without leaking provider details", async () => {
  const { getLocalRecoveryWorker } = await import("@/server/recovery-worker-runtime");
  mocks.worker.mockRejectedValueOnce(new Error("private"));
  await expect(getLocalRecoveryWorker()).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
  expect(mocks.close).toHaveBeenCalledOnce();
  await expect(getLocalRecoveryWorker()).resolves.toHaveProperty("worker");
});
