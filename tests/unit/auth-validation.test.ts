import { describe, expect, it } from "vitest";
import { normalizeEmail } from "@/modules/auth/validation";

describe("global identity email normalization", () => {
  it("normalizes case/outer whitespace without provider-specific rewriting", () => {
    expect(normalizeEmail("  Student.Name+Library@Example.COM ")).toBe("student.name+library@example.com");
    expect(normalizeEmail("a.b@example.com")).not.toBe(normalizeEmail("ab@example.com"));
  });
  it.each(["", "missing", "@example.com", "a@", "a@b@c", "a b@example.com", "a\u0000@example.com", `${"a".repeat(255)}@b`])("rejects invalid input without echoing it: %s", (value) => {
    expect(() => normalizeEmail(value)).toThrow("The request failed validation.");
  });
});
