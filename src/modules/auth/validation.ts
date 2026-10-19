import "server-only";
import { FieldValidationError } from "@/server/http/errors";

// Syntax/normalization only. A valid-looking address is not verified identity.
export function normalizeEmail(value: string): string {
  if (typeof value !== "string") throw new FieldValidationError(["email"], [{ field: "email", code: "INVALID" }]);
  const normalized = value.trim().toLowerCase();
  if (normalized.length > 254 || !/^[^\s@\x00-\x1f\x7f]+@[^\s@\x00-\x1f\x7f]+$/.test(normalized)) {
    throw new FieldValidationError(["email"], [{ field: "email", code: "INVALID" }]);
  }
  return normalized;
}
