import { describe, expect, it } from "vitest";
import type { Connection } from "mongoose";
import { createMongoRateLimiter, normalizeTrustedIp } from "@/server/security/rate-limit";
import { RATE_LIMIT_POLICIES } from "@/server/security/rate-limit-contract";

describe("approved limiter policy and subject normalization", () => {
  it("uses the explicitly approved auth limits", () => {
    expect(RATE_LIMIT_POLICIES["login.ip"]).toEqual({ limit: 30, windowMs: 900_000 });
    expect(RATE_LIMIT_POLICIES["login.account"]).toEqual({ limit: 5, windowMs: 900_000 });
    for (const action of ["registration", "recovery"] as const) {
      expect(RATE_LIMIT_POLICIES[`${action}.ip`]).toEqual({ limit: 5, windowMs: 3_600_000 });
      expect(RATE_LIMIT_POLICIES[`${action}.account`]).toEqual({ limit: 3, windowMs: 3_600_000 });
    }
  });
  it("canonicalizes equivalent IP spellings without trusting header lists", () => {
    expect(normalizeTrustedIp("192.0.2.1")).toBe("192.0.2.1");
    expect(normalizeTrustedIp("::ffff:192.0.2.1")).toBe("192.0.2.1");
    expect(normalizeTrustedIp("2001:0DB8:0000:0000:0000:0000:0000:0001")).toBe("2001:db8::1");
    for (const value of ["", "192.0.2.1, 192.0.2.2", "attacker.example", " 192.0.2.1", "fe80::1%eth0"]) {
      expect(() => normalizeTrustedIp(value)).toThrow("trusted client IP");
    }
  });
  it("requires a strong supplied key and fails closed without provisioned storage", async () => {
    await expect(createMongoRateLimiter({} as Connection, Buffer.alloc(31))).rejects.toThrow("32 secret bytes");
    await expect(createMongoRateLimiter({} as Connection, Buffer.alloc(32))).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
  });
});
