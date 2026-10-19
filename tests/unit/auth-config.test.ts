import { describe, expect, it } from "vitest";
import { readLocalAuthConfiguration } from "@/server/auth-config";

const environment = { NODE_ENV: "development", LIBRARYOS_LOCAL_HTTPS: "1", AUTH_ORIGIN: "https://127.0.0.1:3000",
  AUTH_CSRF_KEY: "1".repeat(64), AUTH_RATE_LIMIT_KEY: "2".repeat(64) };
describe("explicit local HTTPS authentication configuration", () => {
  it("accepts only the approved loopback development target with distinct private keys", () => {
    const configuration = readLocalAuthConfiguration(environment);
    expect(configuration.origin).toBe(environment.AUTH_ORIGIN);
    expect(configuration.csrfKey).toHaveLength(32);
    expect(configuration.limiterKey).toHaveLength(32);
    expect(Object.isFrozen(configuration)).toBe(true);
  });
  it("fails closed for missing keys, HTTP, hosted targets and accidental production use", () => {
    for (const override of [
      { NODE_ENV: "production" }, { NODE_ENV: "test" }, { LIBRARYOS_LOCAL_HTTPS: "" },
      { AUTH_ORIGIN: "http://127.0.0.1:3000" }, { AUTH_ORIGIN: "https://example.com" },
      { AUTH_ORIGIN: "https://127.0.0.1:3000/" }, { AUTH_CSRF_KEY: "private-invalid" },
      { AUTH_RATE_LIMIT_KEY: "" }, { AUTH_RATE_LIMIT_KEY: environment.AUTH_CSRF_KEY },
    ]) {
      expect(() => readLocalAuthConfiguration({ ...environment, ...override })).toThrow("Local authentication configuration is missing or invalid.");
    }
  });
});
