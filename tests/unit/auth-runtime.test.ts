import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ config: vi.fn(), connection: vi.fn(), infrastructure: vi.fn(), identity: vi.fn(), sessions: vi.fn(), limiter: vi.fn(), service: vi.fn() }));
vi.mock("@/server/auth-config", () => ({ readLocalAuthConfiguration: mocks.config }));
vi.mock("@/server/db/connection", () => ({ getDatabaseConnection: mocks.connection }));
vi.mock("@/server/db/storage-contract", () => ({ verifyInfrastructure: mocks.infrastructure }));
vi.mock("@/modules/auth/identity-storage", () => ({ verifyUserIdentity: mocks.identity }));
vi.mock("@/modules/auth/session-storage", () => ({ verifySessions: mocks.sessions }));
vi.mock("@/server/security/rate-limit", () => ({ createMongoRateLimiter: mocks.limiter }));
vi.mock("@/modules/auth/service", () => ({ createAuthService: mocks.service }));
beforeEach(() => {
  vi.resetModules();
  Object.values(mocks).forEach((mock) => mock.mockReset());
  mocks.config.mockReturnValue({ limiterKey: Buffer.alloc(32) });
  mocks.connection.mockResolvedValue({});
  mocks.infrastructure.mockResolvedValue(undefined);
  mocks.identity.mockResolvedValue(undefined);
  mocks.sessions.mockResolvedValue(undefined);
  mocks.limiter.mockResolvedValue({});
  mocks.service.mockResolvedValue({ login: "fixture" });
});

it("shares concurrent initialization and verifies every storage prerequisite", async () => {
  const { getAuthService } = await import("@/server/auth-runtime");
  const [first, second] = await Promise.all([getAuthService(), getAuthService()]);
  expect(first).toBe(second);
  for (const key of ["connection", "infrastructure", "identity", "sessions", "limiter", "service"] as const) expect(mocks[key]).toHaveBeenCalledTimes(1);
});

it("fails closed on readiness errors and retries initialization on the next request", async () => {
  const { getAuthService } = await import("@/server/auth-runtime");
  mocks.identity.mockRejectedValueOnce(new Error("private database detail"));
  await expect(getAuthService()).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
  expect(mocks.service).not.toHaveBeenCalled();
  await expect(getAuthService()).resolves.toEqual({ login: "fixture" });
});
