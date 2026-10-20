import "server-only";
import { createHash } from "node:crypto";
import { openSync, fstatSync, readSync, closeSync } from "node:fs";
import { isAbsolute } from "node:path";
import { ApplicationError } from "@/server/http/errors";
import { createNewPasswordValidator } from "./new-password";

const MAX_FILE_BYTES = 16 * 1024 * 1024;
type Environment = Readonly<Record<string, string | undefined>>;

// Load only during explicit recovery initialization. The caller pins a reviewed
// local artifact; no network service receives passwords or candidate digests.
export function loadPasswordBlocklist(environment: Environment = process.env) {
  let descriptor: number | undefined;
  try {
    const path = environment.AUTH_PASSWORD_BLOCKLIST_PATH ?? "";
    const expected = environment.AUTH_PASSWORD_BLOCKLIST_SHA256 ?? "";
    const source = environment.AUTH_PASSWORD_BLOCKLIST_SOURCE ?? "";
    if (!isAbsolute(path) || !/^[a-f0-9]{64}$/.test(expected) || !source || source.length > 2048 || /[\x00-\x1f\x7f]/.test(source)) throw new Error();
    descriptor = openSync(path, "r");
    const info = fstatSync(descriptor);
    if (!info.isFile() || info.size < 1 || info.size > MAX_FILE_BYTES) throw new Error();
    // Read from the same descriptor, capped even if the local file grows after
    // stat. One extra byte distinguishes an oversized file from exact capacity.
    const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = readSync(descriptor, buffer, length, buffer.length - length, null);
      if (count === 0) break;
      length += count;
    }
    if (length === 0 || length > MAX_FILE_BYTES) throw new Error();
    const bytes = buffer.subarray(0, length);
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (digest !== expected) throw new Error();
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    // Line endings delimit entries; spaces within an entry remain significant.
    const entries = text.split(/\r?\n/).filter((entry) => entry !== "");
    if (entries.length > 1_000_000 || entries.some((entry) => /[\x00-\x1f\x7f]/.test(entry))) throw new Error();
    const validate = createNewPasswordValidator(entries);
    return Object.freeze({ validate, metadata: Object.freeze({ sha256: digest, source, entries: entries.length }) });
  } catch {
    throw new ApplicationError("SERVICE_UNAVAILABLE");
  } finally {
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch { throw new ApplicationError("SERVICE_UNAVAILABLE"); }
    }
  }
}
