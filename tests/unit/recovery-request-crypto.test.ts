import { expect, it } from "vitest";
import { createRequestContext } from "@/server/http/responses";
import { createRecoveryRequestCipher, readRecoveryQueueKey } from "@/modules/auth/recovery-request-crypto";

it("encrypts normalized addresses with randomized fixed-size authenticated records", () => {
  const cipher = createRecoveryRequestCipher(Buffer.alloc(32, 7));
  const id = createRequestContext().requestId;
  const first = cipher.seal(" Reader@Example.com ", "reset-password", id);
  const second = cipher.seal(" Reader@Example.com ", "reset-password", id);
  expect(first.ciphertext).toHaveLength(2048); expect(first).not.toEqual(second);
  expect(JSON.stringify(first)).not.toContain("reader@example.com");
  expect(cipher.open(first, "reset-password", id)).toBe("reader@example.com");
});
it("rejects altered ciphertext, metadata, tag and key without plaintext error details", () => {
  const cipher = createRecoveryRequestCipher(Buffer.alloc(32, 7));
  const id = createRequestContext().requestId;
  const sealed = cipher.seal("reader@example.com", "reset-password", id);
  for (const override of [{ ciphertext: "0".repeat(2048) }, { tag: "0".repeat(32) }, { nonce: "0".repeat(24) }]) {
    expect(() => cipher.open({ ...sealed, ...override }, "reset-password", id)).toThrow("temporarily unavailable");
  }
  expect(() => cipher.open(sealed, "verify-email", id)).toThrow();
  expect(() => cipher.open(sealed, "reset-password", createRequestContext().requestId)).toThrow();
  expect(() => createRecoveryRequestCipher(Buffer.alloc(32, 8)).open(sealed, "reset-password", id)).toThrow();
});
it("requires an independent valid key and snapshots it", () => {
  expect(() => readRecoveryQueueKey({})).toThrow();
  expect(() => readRecoveryQueueKey({ AUTH_RECOVERY_QUEUE_KEY: "ab".repeat(32), AUTH_CSRF_KEY: "ab".repeat(32) })).toThrow();
  const key = readRecoveryQueueKey({ AUTH_RECOVERY_QUEUE_KEY: "ab".repeat(32) });
  const cipher = createRecoveryRequestCipher(key); const id = createRequestContext().requestId;
  const sealed = cipher.seal("reader@example.com", "verify-email", id); key.fill(0);
  expect(cipher.open(sealed, "verify-email", id)).toBe("reader@example.com");
});
