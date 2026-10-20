import { afterEach, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import { loadPasswordBlocklist } from "@/modules/auth/password-blocklist";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) {
    const target = resolve(directory);
    if (!target.startsWith(resolve(tmpdir()) + sep) || !basename(target).startsWith("libraryos-blocklist-")) throw new Error("Refusing cleanup outside the owned temporary fixture.");
    rmSync(target, { recursive: true });
  }
});
function fixture(content: string | Buffer = "A compromised passphrase\r\n  space sensitive phrase  \n") {
  const directory = mkdtempSync(join(tmpdir(), "libraryos-blocklist-"));
  directories.push(directory);
  const path = join(directory, "reviewed-list.txt");
  writeFileSync(path, content);
  return { AUTH_PASSWORD_BLOCKLIST_PATH: path, AUTH_PASSWORD_BLOCKLIST_SHA256: createHash("sha256").update(content).digest("hex"),
    AUTH_PASSWORD_BLOCKLIST_SOURCE: "Synthetic fixture only; not release data" };
}

it("loads a checksum-pinned local artifact and applies whole-password rules", () => {
  const environment = fixture();
  const loaded = loadPasswordBlocklist(environment);
  expect(loaded.metadata).toMatchObject({ sha256: environment.AUTH_PASSWORD_BLOCKLIST_SHA256, entries: 2 });
  expect(() => loaded.validate("A COMPROMISED PASSPHRASE", "reader@example.com")).toThrow();
  expect(() => loaded.validate("  space sensitive phrase  ", "reader@example.com")).toThrow();
  expect(loaded.validate("space sensitive phrase", "reader@example.com")).toBe("space sensitive phrase");
});

it("refuses absent configuration, relative paths, missing source and checksum drift", () => {
  expect(() => loadPasswordBlocklist({})).toThrow("temporarily unavailable");
  const environment = fixture();
  for (const override of [{ AUTH_PASSWORD_BLOCKLIST_PATH: "relative.txt" }, { AUTH_PASSWORD_BLOCKLIST_SOURCE: "" },
    { AUTH_PASSWORD_BLOCKLIST_SHA256: "0".repeat(64) }, { AUTH_PASSWORD_BLOCKLIST_SOURCE: "source\nsecret" }]) {
    expect(() => loadPasswordBlocklist({ ...environment, ...override })).toThrow("temporarily unavailable");
  }
  writeFileSync(environment.AUTH_PASSWORD_BLOCKLIST_PATH, "different content");
  expect(() => loadPasswordBlocklist(environment)).toThrow("temporarily unavailable");
});

it("rejects empty, invalid UTF-8, control-character and oversized artifacts", () => {
  for (const content of ["", "\n\r\n", Buffer.from([0xff]), "a compromised\tpassphrase", Buffer.alloc(16 * 1024 * 1024 + 1, 97)]) {
    expect(() => loadPasswordBlocklist(fixture(content))).toThrow("temporarily unavailable");
  }
});

it("keeps a validated snapshot rather than rereading mutable files per password", () => {
  const environment = fixture();
  const loaded = loadPasswordBlocklist(environment);
  writeFileSync(environment.AUTH_PASSWORD_BLOCKLIST_PATH, "replacement list");
  expect(() => loaded.validate("A compromised passphrase", "reader@example.com")).toThrow();
});
