import "server-only";
import { ApplicationError, FieldValidationError } from "@/server/http/errors";
import { MAX_PASSWORD_BYTES } from "./password-format";
import { NEW_PASSWORD_MIN_CHARACTERS, NEW_PASSWORD_MAX_CHARACTERS } from "./recovery-policy";

// A trusted, locally maintained whole-password list. Fixtures are not a release
// blocklist. No candidate passwords or hashes are sent to external services.
export function createNewPasswordValidator(blocklist: readonly string[]) {
  if (!Array.isArray(blocklist) || blocklist.length === 0 || blocklist.some((word) => typeof word !== "string" || !word || !word.isWellFormed())) {
    throw new ApplicationError("SERVICE_UNAVAILABLE");
  }
  const blocked = new Set(blocklist.map((word) => word.toLowerCase()));
  return (value: unknown, normalizedEmail: string): string => {
    const invalid = () => { throw new FieldValidationError(["password"], [{ field: "password", code: "INVALID" }]); };
    if (typeof value !== "string" || !value.isWellFormed() || Buffer.byteLength(value) > MAX_PASSWORD_BYTES) return invalid();
    const count = Array.from(value).length;
    const folded = value.toLowerCase();
    const account = normalizedEmail.split("@")[0]!;
    if (count < NEW_PASSWORD_MIN_CHARACTERS || count > NEW_PASSWORD_MAX_CHARACTERS
      || blocked.has(folded) || folded.includes("libraryos") || (account.length >= 3 && folded.includes(account))) return invalid();
    return value; // Exact bytes, including whitespace, remain significant.
  };
}
