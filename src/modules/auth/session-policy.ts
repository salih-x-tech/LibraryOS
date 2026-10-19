// Explicitly approved D02 policy, October 19, 2026. No tenant roles live here.
export const SESSION_LIFETIME_MS = 8 * 60 * 60_000;
export const SESSION_IDLE_TIMEOUT_MS = 30 * 60_000;
export const MAX_CONCURRENT_SESSIONS = 3;
export const APPROVED_SESSION_POLICY = Object.freeze({
  allowedUserStatuses: Object.freeze(["active"]),
  requireVerifiedEmail: true,
});
