import { describe, expect, it } from "vitest";
import type { Connection } from "mongoose";
import { createSessionService, type SessionPolicy } from "@/modules/auth/session-service";

describe("explicit session policy", () => {
  it("refuses missing, empty and malformed policy instead of selecting defaults", () => {
    for (const policy of [undefined, {}, { allowedUserStatuses: [] },
      { allowedUserStatuses: ["fixture_active"] }, { allowedUserStatuses: ["$ne"], requireVerifiedEmail: true },
      { allowedUserStatuses: [], requireVerifiedEmail: false },
    ]) {
      expect(() => createSessionService({} as Connection, policy as SessionPolicy)).toThrow("explicit session authorization policy");
    }
  });
});
