import { execFileSync } from "node:child_process";
import { createPrivateKey, createPublicKey, randomBytes, X509Certificate } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

try {
  const directory = resolve(".local/https");
  const keyPath = join(directory, "localhost-key.pem");
  const certPath = join(directory, "localhost-cert.pem");
  mkdirSync(directory, { recursive: true });
  if (!existsSync(keyPath) && !existsSync(certPath)) {
    const gitOpenSsl = "C:/Program Files/Git/usr/bin/openssl.exe";
    const executable = process.platform === "win32" && existsSync(gitOpenSsl) ? gitOpenSsl : "openssl";
    execFileSync(executable, ["req", "-x509", "-newkey", "rsa:2048", "-sha256", "-nodes", "-days", "30",
      "-keyout", keyPath, "-out", certPath, "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1"],
    { stdio: "ignore", windowsHide: true });
  }
  const certificate = new X509Certificate(readFileSync(certPath));
  const privateKey = createPrivateKey(readFileSync(keyPath));
  if (!certificate.checkIP("127.0.0.1") || Date.parse(certificate.validTo) <= Date.now()
    || !createPublicKey(privateKey).export({ type: "spki", format: "der" }).equals(certificate.publicKey.export({ type: "spki", format: "der" }))) {
    throw new Error("Invalid local certificate.");
  }
  if (!existsSync(".env.auth.local")) {
    writeFileSync(".env.auth.local", [
      "# Private local authentication settings. Never commit this file.",
      "AUTH_ORIGIN=https://127.0.0.1:3000",
      `AUTH_CSRF_KEY=${randomBytes(32).toString("hex")}`,
      `AUTH_RATE_LIMIT_KEY=${randomBytes(32).toString("hex")}`, "",
    ].join("\n"), { flag: "wx", mode: 0o600 });
  }
  console.log("Local HTTPS certificate and private auth settings are ready. Existing settings were preserved. Run npm run dev:https.");
} catch {
  console.error("Local HTTPS setup failed. Check OpenSSL availability and existing local certificate files. No secrets are printed.");
  process.exitCode = 1;
}
