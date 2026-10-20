import { expect, it } from "vitest";
import { createActionToken, hashActionToken } from "@/modules/auth/action-token-format";

it("creates independent 256-bit credentials bound to protocol and purpose", () => {
  const first = createActionToken("verify-email");
  const second = createActionToken("verify-email");
  expect(first.token).toHaveLength(43);
  expect(first.token).not.toBe(second.token);
  expect(first.tokenHash).toMatch(/^[a-f0-9]{64}$/);
  expect(hashActionToken("verify-email", first.token)).toBe(first.tokenHash);
  expect(hashActionToken("reset-password", first.token)).not.toBe(first.tokenHash);
});

it("rejects malformed and noncanonical tokens before hashing", () => {
  for (const token of ["", "x".repeat(44), "x".repeat(42) + "B", "x".repeat(43) + "\n", "../secret"]) {
    expect(hashActionToken("reset-password", token)).toBeNull();
  }
  expect(() => createActionToken("unknown" as "verify-email")).toThrow();
});
