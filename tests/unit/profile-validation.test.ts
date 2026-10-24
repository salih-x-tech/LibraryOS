import { expect, it } from "vitest";
import { validateProfileInput } from "@/modules/auth/profile-service";
it("allows a trimmed display name or clearing it, and rejects malformed or privileged input", () => {
  expect(validateProfileInput({ displayName: " Reader " })).toBe("Reader");
  expect(validateProfileInput({ displayName: "" })).toBe("");
  for (const input of [null, [], {}, { displayName: 1 }, { displayName: "x".repeat(101) },
    { displayName: "bad\nname" }, { displayName: "\ud800" }, { displayName: "Reader", role: "Owner" }]) {
    expect(() => validateProfileInput(input)).toThrow();
  }
});
