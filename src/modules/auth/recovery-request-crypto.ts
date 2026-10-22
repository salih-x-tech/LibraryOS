import "server-only";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { ApplicationError } from "@/server/http/errors";
import { requestId } from "@/server/db/persistence";
import { assertActionTokenPurpose, type ActionTokenPurpose } from "./action-token-format";
import { normalizeEmail } from "./validation";

export type SealedRecoveryRequest = Readonly<{ ciphertext: string; nonce: string; tag: string }>;
export function readRecoveryQueueKey(environment: Readonly<Record<string, string | undefined>> = process.env): Buffer {
  const encoded = environment.AUTH_RECOVERY_QUEUE_KEY ?? "";
  if (!/^[a-f0-9]{64}$/.test(encoded) || [environment.AUTH_CSRF_KEY, environment.AUTH_RATE_LIMIT_KEY].includes(encoded)) throw new ApplicationError("SERVICE_UNAVAILABLE");
  return Buffer.from(encoded, "hex");
}

export function createRecoveryRequestCipher(secret: Uint8Array) {
  if (!(secret instanceof Uint8Array) || secret.byteLength !== 32) throw new ApplicationError("SERVICE_UNAVAILABLE");
  const key = Buffer.from(secret);
  function aad(purpose: ActionTokenPurpose, correlation: string) {
    assertActionTokenPurpose(purpose); requestId(correlation);
    return Buffer.from(JSON.stringify(["libraryos.recovery-request.v1", purpose, correlation]));
  }
  function seal(email: string, purpose: ActionTokenPurpose, correlation: string): SealedRecoveryRequest {
    const encoded = Buffer.from(normalizeEmail(email), "utf8");
    if (encoded.length > 1022) throw new ApplicationError("BAD_REQUEST");
    // Fixed-size plaintext avoids disclosing address length in queue records.
    const padded = Buffer.alloc(1024); padded.writeUInt16BE(encoded.length); encoded.copy(padded, 2);
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, nonce); cipher.setAAD(aad(purpose, correlation));
    const ciphertext = Buffer.concat([cipher.update(padded), cipher.final()]);
    return Object.freeze({ ciphertext: ciphertext.toString("hex"), nonce: nonce.toString("hex"), tag: cipher.getAuthTag().toString("hex") });
  }
  function open(record: SealedRecoveryRequest, purpose: ActionTokenPurpose, correlation: string): string {
    try {
      if (!/^[a-f0-9]{2048}$/.test(record.ciphertext) || !/^[a-f0-9]{24}$/.test(record.nonce) || !/^[a-f0-9]{32}$/.test(record.tag)) throw new Error();
      const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(record.nonce, "hex"));
      decipher.setAAD(aad(purpose, correlation)); decipher.setAuthTag(Buffer.from(record.tag, "hex"));
      const plaintext = Buffer.concat([decipher.update(Buffer.from(record.ciphertext, "hex")), decipher.final()]);
      const length = plaintext.readUInt16BE();
      if (length < 1 || length > 1022) throw new Error();
      const email = new TextDecoder("utf-8", { fatal: true }).decode(plaintext.subarray(2, length + 2));
      if (normalizeEmail(email) !== email) throw new Error();
      return email;
    } catch { throw new ApplicationError("SERVICE_UNAVAILABLE"); }
  }
  return Object.freeze({ seal, open });
}
