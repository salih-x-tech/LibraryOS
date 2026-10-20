import { expect, it } from "vitest";
import { createNewPasswordValidator } from "@/modules/auth/new-password";

const validate = createNewPasswordValidator(["a compromised password"]);
it("counts Unicode code points, preserves whitespace and accepts long passphrases", () => {
  for (const candidate of ["🐱".repeat(15), "  a pleasant long phrase  ", "x".repeat(128)]) expect(validate(candidate, "reader@example.com")).toBe(candidate);
});
it("rejects short, oversized, malformed, blocked and account/service-specific passwords", () => {
  for (const candidate of ["x".repeat(14), "x".repeat(129), "\ud800".repeat(15), "A COMPROMISED PASSWORD", "my LibraryOS phrase", "reader password phrase"]) {
    expect(() => validate(candidate, "reader@example.com")).toThrow();
  }
});
it("fails closed without a valid local blocklist", () => {
  for (const list of [[], [""], ["\ud800"]]) expect(() => createNewPasswordValidator(list)).toThrow();
});
