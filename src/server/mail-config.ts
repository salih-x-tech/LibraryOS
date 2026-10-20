import "server-only";
import { ApplicationError } from "./http/errors";

type Environment = Readonly<Record<string, string | undefined>>;
export type GmailConfiguration = Readonly<{ user: string; appPassword: string; senderName: string; origin: string }>;

export function readGmailConfiguration(environment: Environment = process.env): GmailConfiguration {
  try {
    if (environment.NODE_ENV !== "development" || environment.LIBRARYOS_LOCAL_HTTPS !== "1") throw new Error();
    const origin = environment.AUTH_ORIGIN ?? "";
    const parsed = new URL(origin);
    if (parsed.protocol !== "https:" || parsed.hostname !== "127.0.0.1" || parsed.origin !== origin) throw new Error();
    const user = (environment.GMAIL_USER ?? "").trim().toLowerCase();
    if (!/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@gmail\.com$/.test(user) || user.length > 254) throw new Error();
    const raw = environment.GMAIL_APP_PASSWORD ?? "";
    if (!/^[A-Za-z0-9 ]{16,19}$/.test(raw)) throw new Error();
    const appPassword = raw.replaceAll(" ", "");
    if (appPassword.length !== 16) throw new Error();
    const senderName = environment.GMAIL_SENDER_NAME?.trim() ?? "LibraryOS";
    if (!senderName || senderName.length > 100 || /[\x00-\x1f\x7f]/.test(senderName)) throw new Error();
    return Object.freeze({ user, appPassword, senderName, origin });
  } catch { throw new ApplicationError("SERVICE_UNAVAILABLE"); }
}
