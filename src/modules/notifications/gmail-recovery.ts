import "server-only";
import nodemailer from "nodemailer";
import { ApplicationError } from "@/server/http/errors";
import { readGmailConfiguration } from "@/server/mail-config";
import { hashActionToken, type ActionTokenPurpose } from "@/modules/auth/action-token-format";
import { RESET_LIFETIME_MS, VERIFICATION_LIFETIME_MS } from "@/modules/auth/recovery-policy";

export type RecoveryEmail = Readonly<{ email: string; purpose: ActionTokenPurpose; url: string }>;

// This adapter does not enable recovery routes or start any connection on import.
// Call only after a token issuance transaction commits. No automatic send retry:
// an SMTP acknowledgment can be lost after delivery, so retries can duplicate it.
export function createGmailRecoveryDelivery(environment: Readonly<Record<string, string | undefined>> = process.env) {
  const configuration = readGmailConfiguration(environment);
  const transport = nodemailer.createTransport({
    host: "smtp.gmail.com", port: 465, secure: true,
    auth: { user: configuration.user, pass: configuration.appPassword },
    tls: { rejectUnauthorized: true, servername: "smtp.gmail.com", minVersion: "TLSv1.2" },
    connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 15_000, dnsTimeout: 5000,
    logger: false, debug: false, disableFileAccess: true, disableUrlAccess: true,
  });
  async function safe<T>(work: () => Promise<T>): Promise<T> {
    try { return await work(); } catch { throw new ApplicationError("SERVICE_UNAVAILABLE"); }
  }
  async function ready(): Promise<void> {
    return safe(async () => { if (!await transport.verify()) throw new Error(); });
  }
  async function send(message: RecoveryEmail): Promise<void> {
    return safe(async () => {
      // One simple mailbox only; prohibit display-name/address-list injection.
      if (typeof message.email !== "string" || message.email.length > 254
        || !/^[^\s<>(),:;\[\]"\\@\x00-\x1f\x7f]+@[^\s<>(),:;\[\]"\\@\x00-\x1f\x7f]+\.[^\s<>(),:;\[\]"\\@\x00-\x1f\x7f]+$/.test(message.email)) throw new Error();
      const link = new URL(message.url);
      const token = new URLSearchParams(link.hash.slice(1)).get("token");
      if (link.origin !== configuration.origin || link.username || link.password || link.search
        || link.pathname !== `/${message.purpose}` || !token || !hashActionToken(message.purpose, token)
        || link.hash !== `#token=${token}`) throw new Error();
      const verify = message.purpose === "verify-email";
      const lifetime = verify ? VERIFICATION_LIFETIME_MS : RESET_LIFETIME_MS;
      const result = await transport.sendMail({
        from: { name: configuration.senderName, address: configuration.user },
        to: [{ address: message.email }], envelope: { from: configuration.user, to: [message.email] },
        subject: verify ? "Verify your LibraryOS email" : "Reset your LibraryOS password",
        text: [verify ? "Confirm your LibraryOS email using this link:" : "Reset your LibraryOS password using this link:",
          message.url, `This link expires in ${lifetime / 60_000} minutes and can be used once.`,
          "If you did not request this, you can ignore this message.",
          "This link opens LibraryOS on this computer's local HTTPS development server."].join("\n\n"),
        disableFileAccess: true, disableUrlAccess: true,
      });
      if (!result.accepted.some((address) => String(address).toLowerCase() === message.email.toLowerCase()) || result.rejected.length > 0) throw new Error();
    });
  }
  return Object.freeze({ kind: "gmail-smtp" as const, ready, send, close: () => transport.close() });
}
