// Shared, non-secret format contract used by the model and deployment validator.
// Explicit verification envelope prevents stored parameters requesting huge work.
export const PASSWORD_HASH_PATTERN = "^\\$argon2id\\$v=19\\$m=(19456|32768|65536|131072),p=[1-4],t=[2-6]\\$[A-Za-z0-9+/]{21}[AQgw]\\$[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]$";
const supportedHash = new RegExp(PASSWORD_HASH_PATTERN);
export const MAX_PASSWORD_BYTES = 4096;

export function isSupportedPasswordHash(value: string): boolean {
  return typeof value === "string" && value.length <= 128 && supportedHash.test(value);
}
