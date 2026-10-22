// Explicit worker/retention choices approved October 22, 2026.
export const RECOVERY_REQUEST_LEASE_MS = 2 * 60_000;
export const RECOVERY_REQUEST_PENDING_MS = 24 * 60 * 60_000;
export const RECOVERY_REQUEST_TERMINAL_MS = 7 * 24 * 60 * 60_000;
export const RECOVERY_TERMINAL_STATES = ["completed", "failed", "uncertain", "expired"] as const;
