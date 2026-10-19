import { describe, expect, it, vi } from "vitest";
import * as argon2 from "argon2";
import { hashPassword, verifyPassword, MAX_PASSWORD_BYTES } from "@/modules/auth/passwords";
import { isSupportedPasswordHash } from "@/modules/auth/password-format";

vi.mock("argon2", { spy: true });

describe("Argon2id password storage", () => {
  it("uses fresh salts, explicit parameters and verifies correct passwords only", async () => {
    const password = "Synthetic password 42!";
    const first = await hashPassword(password);
    const second = await hashPassword(password);
    expect(first).not.toBe(second);
    expect(first).toMatch(/^\$argon2id\$v=19\$m=65536,p=1,t=3\$/);
    expect(isSupportedPasswordHash(first)).toBe(true);
    expect(first).not.toContain(password);
    expect(await verifyPassword(password, first)).toEqual({ verified: true, needsRehash: false });
    expect(await verifyPassword("different", first)).toEqual({ verified: false, needsRehash: false });
  });
  it("preserves whitespace, Unicode and long passwords without silent truncation", async () => {
    const password = `  کتاب 📚 ${"x".repeat(200)}  `;
    const hash = await hashPassword(password);
    expect((await verifyPassword(password, hash)).verified).toBe(true);
    expect((await verifyPassword(password.trim(), hash)).verified).toBe(false);
    expect((await verifyPassword(`${password}x`, hash)).verified).toBe(false);
  });
  it("signals rehash only after successful verification of an older supported profile", async () => {
    const hash = await argon2.hash("synthetic", { type: argon2.argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1, hashLength: 32 });
    expect(await verifyPassword("synthetic", hash)).toEqual({ verified: true, needsRehash: true });
    expect(await verifyPassword("incorrect", hash)).toEqual({ verified: false, needsRehash: false });
  });
  it("rejects malformed/unsupported hashes before invoking native verification", async () => {
    const verify = vi.mocked(argon2.verify);
    const valid = await hashPassword("synthetic");
    for (const hash of ["", "plaintext", valid.replace("argon2id", "argon2i"), valid.replace("v=19", "v=16"),
      valid.replace("m=65536", "m=999999999"), valid.replace("t=3", "t=9999"), `${valid}=`, "x".repeat(1000)]) {
      expect(await verifyPassword("synthetic", hash)).toEqual({ verified: false, needsRehash: false });
    }
    expect(verify).not.toHaveBeenCalled();
  });
  it("bounds input bytes, rejects malformed Unicode and returns sanitized validation", async () => {
    for (const password of ["", "x".repeat(MAX_PASSWORD_BYTES + 1), "📚".repeat(1025), "\ud800"]) {
      await expect(hashPassword(password)).rejects.toMatchObject({ code: "VALIDATION_FAILED", fields: [{ field: "password", code: "INVALID" }] });
      expect(await verifyPassword(password, "invalid")).toEqual({ verified: false, needsRehash: false });
    }
  });
  it("sanitizes native hashing/verification errors without retaining a cause", async () => {
    const valid = await hashPassword("synthetic");
    vi.mocked(argon2.hash).mockRejectedValueOnce(new Error("private-password"));
    await expect(hashPassword("synthetic")).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
    vi.mocked(argon2.verify).mockRejectedValueOnce(new Error("private-hash"));
    try {
      await verifyPassword("synthetic", valid);
      expect.fail("Expected safe failure");
    } catch (error) {
      expect(error).toMatchObject({ code: "SERVICE_UNAVAILABLE" });
      expect(error).not.toHaveProperty("cause");
      expect(String(error)).not.toMatch(/private|synthetic/);
    }
  });
});
