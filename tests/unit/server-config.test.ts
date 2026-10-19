import { describe, expect, it } from "vitest";
import { ConfigurationError, readDatabaseConfig } from "@/server/config";

const local = {
  NODE_ENV: "development",
  MONGODB_URI: "mongodb://127.0.0.1:27017/",
  MONGODB_DB_NAME: "libraryos_development",
};

describe("database configuration", () => {
  it("validates explicitly and returns immutable server configuration", () => {
    const config = readDatabaseConfig(local);
    expect(config.databaseName).toBe("libraryos_development");
    expect(Object.isFrozen(config)).toBe(true);
  });

  it.each([
    { ...local, MONGODB_URI: undefined },
    { ...local, MONGODB_DB_NAME: undefined },
    { ...local, MONGODB_DB_NAME: "../production" },
    { ...local, MONGODB_URI: "unsupported://redaction-probe" },
    { ...local, NODE_ENV: "prod" },
    { ...local, NODE_ENV: "production" },
    { ...local, NODE_ENV: "production", MONGODB_URI: "mongodb://db.example.invalid/?tls=true&tlsAllowInvalidCertificates=true" },
    { ...local, NODE_ENV: "production", MONGODB_URI: "mongodb://db.example.invalid/?tls=true&tlsAllowInvalidHostnames=true" },
    { ...local, NODE_ENV: "production", MONGODB_URI: "mongodb://db.example.invalid/?tls=true&tlsInsecure=true" },
  ])("rejects missing, invalid or insecure settings", (environment) => {
    expect(() => readDatabaseConfig(environment)).toThrow(ConfigurationError);
  });

  it("accepts verified TLS in production without making a connection", () => {
    expect(readDatabaseConfig({ ...local, NODE_ENV: "production", MONGODB_URI: "mongodb://db.example.invalid/?tls=true" }).databaseName).toBe(local.MONGODB_DB_NAME);
    expect(readDatabaseConfig({ ...local, NODE_ENV: "production", MONGODB_URI: "mongodb+srv://db.example.invalid/" }).databaseName).toBe(local.MONGODB_DB_NAME);
  });

  it("does not expose the rejected URI or its parse error", () => {
    try {
      readDatabaseConfig({ ...local, MONGODB_URI: "unsupported://redaction-probe" });
      expect.fail("Expected validation to reject the URI");
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(ConfigurationError);
      expect(String(error)).not.toContain("redaction-probe");
      expect(JSON.stringify(error)).not.toContain("redaction-probe");
      expect(error).not.toHaveProperty("cause");
    }
  });
});
