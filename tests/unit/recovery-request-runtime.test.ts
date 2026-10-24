import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ config: vi.fn(), connection: vi.fn(), limiter: vi.fn(), queue: vi.fn() }));
vi.mock("@/server/auth-config", () => ({ readLocalAuthConfiguration: mocks.config }));
vi.mock("@/server/db/connection", () => ({ getDatabaseConnection: mocks.connection }));
vi.mock("@/server/security/rate-limit", () => ({ createMongoRateLimiter: mocks.limiter }));
vi.mock("@/modules/auth/recovery-requests", () => ({ createRecoveryRequestQueue: mocks.queue }));
beforeEach(() => {
  vi.resetModules(); Object.values(mocks).forEach((mock) => mock.mockReset());
  mocks.config.mockReturnValue({ limiterKey: Buffer.alloc(32, 2) }); mocks.connection.mockResolvedValue({});
  mocks.limiter.mockResolvedValue({}); mocks.queue.mockResolvedValue({ enqueue: "fixture" });
  vi.stubEnv("AUTH_RECOVERY_QUEUE_KEY", "ef".repeat(32));
});
afterEach(() => vi.unstubAllEnvs());
it("shares queue initialization without any mail or identity dependency", async () => {
  const { getLocalRecoveryRequestQueue } = await import("@/server/recovery-request-runtime");
  const result = await Promise.all([getLocalRecoveryRequestQueue(), getLocalRecoveryRequestQueue()]);
  expect(result[0]).toBe(result[1]); expect(mocks.connection).toHaveBeenCalledOnce(); expect(mocks.queue).toHaveBeenCalledOnce();
});
it("refuses missing keys before database access and retries failed readiness", async () => {
  const { getLocalRecoveryRequestQueue } = await import("@/server/recovery-request-runtime");
  vi.stubEnv("AUTH_RECOVERY_QUEUE_KEY", "");
  await expect(getLocalRecoveryRequestQueue()).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
  expect(mocks.connection).not.toHaveBeenCalled();
  vi.stubEnv("AUTH_RECOVERY_QUEUE_KEY", "ef".repeat(32)); mocks.queue.mockRejectedValueOnce(new Error("private"));
  await expect(getLocalRecoveryRequestQueue()).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
  await expect(getLocalRecoveryRequestQueue()).resolves.toEqual({ enqueue: "fixture" });
});
