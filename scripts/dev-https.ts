import { spawn } from "node:child_process";
import { createPrivateKey, createPublicKey, X509Certificate } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { readLocalAuthConfiguration } from "../src/server/auth-config.ts";

try {
  // Test/dev callers can provide their own complete environment; do not load
  // private local settings when an explicit origin is already supplied.
  if (!process.env.AUTH_ORIGIN && existsSync(".env.auth.local")) process.loadEnvFile(".env.auth.local");
  const environment = { ...process.env, NODE_ENV: "development" as const, LIBRARYOS_LOCAL_HTTPS: "1" };
  const configuration = readLocalAuthConfiguration(environment);
  const origin = new URL(configuration.origin);
  const keyPath = resolve(".local/https/localhost-key.pem");
  const certPath = resolve(".local/https/localhost-cert.pem");
  const certificate = new X509Certificate(readFileSync(certPath));
  const key = createPrivateKey(readFileSync(keyPath));
  if (!certificate.checkIP("127.0.0.1") || Date.parse(certificate.validTo) <= Date.now()
    || !createPublicKey(key).export({ type: "spki", format: "der" }).equals(certificate.publicKey.export({ type: "spki", format: "der" }))) throw new Error();
  const child = spawn(process.execPath, [resolve("node_modules/next/dist/bin/next"), "dev", "--hostname", "127.0.0.1",
    "--port", origin.port || "443", "--experimental-https", "--experimental-https-key", keyPath, "--experimental-https-cert", certPath],
  { env: environment, stdio: "inherit", windowsHide: true });
  child.once("error", () => { console.error("Local HTTPS server failed to start."); process.exitCode = 1; });
  child.once("exit", (code) => { process.exitCode = code ?? 1; });
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => { child.kill(signal); });
} catch {
  console.error("Local HTTPS configuration is missing or invalid. Run npm run auth:local:setup. No secrets are printed.");
  process.exitCode = 1;
}
