import "server-only";
import { ApplicationError, FieldValidationError } from "@/server/http/errors";
import { MAX_PASSWORD_BYTES } from "./password-format";

// Syntax/normalization only. A valid-looking address is not verified identity.
export function normalizeEmail(value: string): string {
  if (typeof value !== "string") throw new FieldValidationError(["email"], [{ field: "email", code: "INVALID" }]);
  const normalized = value.trim().toLowerCase();
  if (normalized.length > 254 || !/^[^\s@\x00-\x1f\x7f]+@[^\s@\x00-\x1f\x7f]+$/.test(normalized)) {
    throw new FieldValidationError(["email"], [{ field: "email", code: "INVALID" }]);
  }
  return normalized;
}

export function validateLoginInput(value: unknown): Readonly<{ email: string; password: string }> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) throw new ApplicationError("BAD_REQUEST");
  const input = value as Record<string, unknown>;
  if (Object.keys(input).length !== 2 || !Object.hasOwn(input, "email") || !Object.hasOwn(input, "password")) throw new ApplicationError("BAD_REQUEST");
  if (typeof input.email !== "string") throw new FieldValidationError(["email"], [{ field: "email", code: "INVALID" }]);
  if (typeof input.password !== "string" || !input.password || !input.password.isWellFormed() || Buffer.byteLength(input.password) > MAX_PASSWORD_BYTES) {
    throw new FieldValidationError(["password"], [{ field: "password", code: "INVALID" }]);
  }
  return Object.freeze({ email: normalizeEmail(input.email), password: input.password });
}
