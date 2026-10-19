import { randomBytes } from "node:crypto";
import { cpus, totalmem } from "node:os";
import { performance } from "node:perf_hooks";
import { hashPassword, verifyPassword, PASSWORD_HASH_OPTIONS } from "../src/modules/auth/passwords.ts";

// Synthetic input only. Never accept/print real passwords or generated hashes.
try {
  const password = randomBytes(32).toString("hex");
  await hashPassword(password); // warm up the native binding
  const hashing: number[] = [];
  const verification: number[] = [];
  for (let index = 0; index < 5; index++) {
    let start = performance.now();
    const hash = await hashPassword(password);
    hashing.push(performance.now() - start);
    start = performance.now();
    if (!(await verifyPassword(password, hash)).verified) throw new Error("Benchmark verification failed.");
    verification.push(performance.now() - start);
  }
  const start = performance.now();
  await Promise.all([hashPassword(password), hashPassword(password)]);
  const concurrentTwoHashMs = performance.now() - start;
  function summary(values: number[]) {
    const sorted = [...values].sort((a, b) => a - b);
    return { samples: values.length, medianMs: Math.round(sorted[2]!), maxMs: Math.round(sorted[sorted.length - 1]!) };
  }
  console.log(JSON.stringify({
    node: process.version, platform: process.platform, architecture: process.arch,
    cpu: cpus()[0]?.model, logicalCpus: cpus().length, totalMemoryMiB: Math.round(totalmem() / 1024 ** 2),
    profile: PASSWORD_HASH_OPTIONS, hash: summary(hashing), verify: summary(verification),
    concurrentTwoHashMs: Math.round(concurrentTwoHashMs), peakProcessRssKiB: process.resourceUsage().maxRSS,
    note: "Local synthetic sample only; repeat on deployment hardware under realistic load before release.",
  }, null, 2));
} catch {
  console.error("Password benchmark failed; no credential material is printed.");
  process.exitCode = 1;
}
