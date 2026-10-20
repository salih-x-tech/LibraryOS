import { createHash, randomBytes } from "node:crypto";
import { SESSION_TOKEN_PATTERN } from "./session-format.ts";

export const ACTION_TOKEN_PURPOSES = ["verify-email", "reset-password"] as const;
export type ActionTokenPurpose = typeof ACTION_TOKEN_PURPOSES[number];
const pattern = new RegExp(SESSION_TOKEN_PATTERN);

export function assertActionTokenPurpose(purpose: ActionTokenPurpose): void {
  if (!ACTION_TOKEN_PURPOSES.includes(purpose)) throw new Error("Invalid authentication token purpose.");
}

export function hashActionToken(purpose: ActionTokenPurpose, token: string): string | null {
  assertActionTokenPurpose(purpose);
  if (typeof token !== "string" || token.length !== 43 || !pattern.test(token)) return null;
  return createHash("sha256").update(JSON.stringify(["libraryos.action-token.v1", purpose, token])).digest("hex");
}

export function createActionToken(purpose: ActionTokenPurpose) {
  assertActionTokenPurpose(purpose);
  const token = randomBytes(32).toString("base64url");
  return Object.freeze({ token, tokenHash: hashActionToken(purpose, token)! });
}
