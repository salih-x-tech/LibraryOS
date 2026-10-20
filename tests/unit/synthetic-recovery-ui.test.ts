import { afterEach, expect, it, vi } from "vitest";
import { syntheticRecoveryUiEnabled } from "@/server/synthetic-recovery-ui";
afterEach(() => vi.unstubAllEnvs());

it("requires the explicit synthetic UI switch, approved launcher and disposable loopback database", () => {
  const environment = { NODE_ENV: "development", LIBRARYOS_LOCAL_HTTPS: "1", AUTH_ORIGIN: "https://127.0.0.1:3102",
    AUTH_CSRF_KEY: "ab".repeat(32), AUTH_RATE_LIMIT_KEY: "cd".repeat(32), LIBRARYOS_SYNTHETIC_RECOVERY_UI: "1",
    MONGODB_URI: "mongodb://127.0.0.1:27017", MONGODB_DB_NAME: "libraryos_test_abcd" };
  for (const [key, value] of Object.entries(environment)) vi.stubEnv(key, value);
  expect(syntheticRecoveryUiEnabled()).toBe(true);
  for (const [key, value] of Object.entries({ LIBRARYOS_SYNTHETIC_RECOVERY_UI: "", NODE_ENV: "production", LIBRARYOS_LOCAL_HTTPS: "",
    MONGODB_URI: "mongodb://example.com:27017", MONGODB_DB_NAME: "libraryos" })) {
    vi.stubEnv(key, value); expect(syntheticRecoveryUiEnabled()).toBe(false);
    vi.stubEnv(key, environment[key as keyof typeof environment]);
  }
});
