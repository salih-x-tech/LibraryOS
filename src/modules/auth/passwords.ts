import "server-only";
import * as argon2 from "argon2";
import { ApplicationError, FieldValidationError } from "../../server/http/errors.ts";
import { isSupportedPasswordHash, MAX_PASSWORD_BYTES } from "./password-format.ts";

export const PASSWORD_HASH_OPTIONS = Object.freeze({
  type: argon2.argon2id, version: 0x13, memoryCost: 65_536,
  timeCost: 3, parallelism: 1, hashLength: 32,
});

// Infrastructure input bound, not the still-unapproved user password policy.
export { MAX_PASSWORD_BYTES } from "./password-format.ts";

function validInput(password: string): boolean {
  return typeof password === "string" && password.length > 0 && password.isWellFormed()
    && Buffer.byteLength(password, "utf8") <= MAX_PASSWORD_BYTES;
}

export async function hashPassword(password: string): Promise<string> {
  if (!validInput(password)) throw new FieldValidationError(["password"], [{ field: "password", code: "INVALID" }]);
  try {
    // The library generates a fresh cryptographic 16-byte salt per call.
    const hash = await argon2.hash(password, PASSWORD_HASH_OPTIONS);
    if (!isSupportedPasswordHash(hash)) throw new Error("Unexpected hash format.");
    return hash;
  } catch {
    throw new ApplicationError("SERVICE_UNAVAILABLE");
  }
}

export type PasswordVerification = Readonly<{ verified: boolean; needsRehash: boolean }>;

export async function verifyPassword(password: string, encodedHash: string): Promise<PasswordVerification> {
  if (!validInput(password) || !isSupportedPasswordHash(encodedHash)) return { verified: false, needsRehash: false };
  try {
    const verified = await argon2.verify(encodedHash, password);
    return { verified, needsRehash: verified && argon2.needsRehash(encodedHash, PASSWORD_HASH_OPTIONS) };
  } catch {
    throw new ApplicationError("SERVICE_UNAVAILABLE");
  }
}
