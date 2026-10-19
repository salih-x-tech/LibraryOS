import { describe, expect, it } from "vitest";
import type { Connection } from "mongoose";
import { createSessionService, type SessionPolicy } from "@/modules/auth/session-service";
import { APPROVED_SESSION_POLICY, SESSION_LIFETIME_MS, SESSION_IDLE_TIMEOUT_MS, MAX_CONCURRENT_SESSIONS } from "@/modules/auth/session-policy";

describe("explicit session policy", () => {
  it("records the user's approved global login and session policy", () => {
    expect(APPROVED_SESSION_POLICY).toEqual({ allowedUserStatuses: ["active"], requireVerifiedEmail: true });
    expect(SESSION_LIFETIME_MS).toBe(28_800_000);
    expect(SESSION_IDLE_TIMEOUT_MS).toBe(1_800_000);
    expect(MAX_CONCURRENT_SESSIONS).toBe(3);
  });
  it("refuses missing, empty and malformed policy instead of selecting defaults", () => {
    for (const policy of [undefined, {}, { allowedUserStatuses: [] },
      { allowedUserStatuses: ["fixture_active"] }, { allowedUserStatuses: ["$ne"], requireVerifiedEmail: true },
      { allowedUserStatuses: [], requireVerifiedEmail: false },
    ]) {
      expect(() => createSessionService({} as Connection, policy as SessionPolicy)).toThrow("explicit session authorization policy");
    }
  });
});
