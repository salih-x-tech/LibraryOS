import "server-only";
import { readLocalAuthConfiguration } from "./auth-config";

// UI-only fixture switch; no recovery API or delivery adapter is enabled by it.
export function syntheticRecoveryUiEnabled(): boolean {
  try {
    readLocalAuthConfiguration();
    const uri = new URL(process.env.MONGODB_URI ?? "");
    return process.env.LIBRARYOS_SYNTHETIC_RECOVERY_UI === "1" && uri.protocol === "mongodb:"
      && uri.hostname === "127.0.0.1" && !uri.username && !uri.password
      && /^libraryos_test_[a-f0-9]+$/.test(process.env.MONGODB_DB_NAME ?? "");
  } catch { return false; }
}

export function localRecoveryUiEnabled(): boolean {
  try {
    readLocalAuthConfiguration();
    return process.env.AUTH_RECOVERY_UI === "1" && process.env.AUTH_RECOVERY_REQUEST_HTTP === "1"
      && process.env.AUTH_RECOVERY_COMPLETION_HTTP === "1";
  } catch { return false; }
}
