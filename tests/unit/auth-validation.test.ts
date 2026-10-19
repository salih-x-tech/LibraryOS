import { describe, expect, it } from "vitest";
import { normalizeEmail, validateLoginInput } from "@/modules/auth/validation";

describe("global identity email normalization", () => {
  it("accepts only the credential DTO without trimming passwords or accepting privileges", () => {
    expect(validateLoginInput({ email: " Student@Example.com ", password: " exact password " })).toEqual({ email: "student@example.com", password: " exact password " });
    for (const value of [null, [], {}, { email: "a@b", password: "x", role: "Owner" }, JSON.parse('{"email":"a@b","password":"x","__proto__":{}}'),
      { email: 1, password: "x" }, { email: "a@b", password: "" }, { email: "a@b", password: "x".repeat(4097) }]) {
      expect(() => validateLoginInput(value)).toThrow();
    }
  });
  it("normalizes case/outer whitespace without provider-specific rewriting", () => {
    expect(normalizeEmail("  Student.Name+Library@Example.COM ")).toBe("student.name+library@example.com");
    expect(normalizeEmail("a.b@example.com")).not.toBe(normalizeEmail("ab@example.com"));
  });
  it.each(["", "missing", "@example.com", "a@", "a@b@c", "a b@example.com", "a\u0000@example.com", `${"a".repeat(255)}@b`])("rejects invalid input without echoing it: %s", (value) => {
    expect(() => normalizeEmail(value)).toThrow("The request failed validation.");
  });
});
