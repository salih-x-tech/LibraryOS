import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ createTransport: vi.fn(), verify: vi.fn(), sendMail: vi.fn(), close: vi.fn() }));
vi.mock("nodemailer", () => ({ default: { createTransport: mocks.createTransport } }));
import { createGmailRecoveryDelivery } from "@/modules/notifications/gmail-recovery";
import { readGmailConfiguration } from "@/server/mail-config";
import { createActionToken } from "@/modules/auth/action-token-format";

// Entirely synthetic: no user's address, password or real SMTP connection.
const environment = { NODE_ENV: "development", LIBRARYOS_LOCAL_HTTPS: "1", AUTH_ORIGIN: "https://127.0.0.1:3000",
  GMAIL_USER: "sender.fixture@gmail.com", GMAIL_SENDER_NAME: "Fixture Sender", GMAIL_APP_PASSWORD: "abcd efgh ijkl mnop" };
const recipient = "recipient@example.com";
beforeEach(() => {
  mocks.createTransport.mockReset().mockReturnValue({ verify: mocks.verify, sendMail: mocks.sendMail, close: mocks.close });
  mocks.verify.mockReset().mockResolvedValue(true);
  mocks.sendMail.mockReset().mockResolvedValue({ accepted: [recipient], rejected: [] });
  mocks.close.mockReset();
});
function message(purpose: "reset-password" | "verify-email" = "reset-password") {
  return { email: recipient, purpose, url: `${environment.AUTH_ORIGIN}/${purpose}#token=${createActionToken(purpose).token}` };
}

it("requires valid local launcher settings and private app credentials", () => {
  expect(readGmailConfiguration(environment).appPassword).toBe("abcdefghijklmnop");
  for (const override of [{ NODE_ENV: "production" }, { LIBRARYOS_LOCAL_HTTPS: "" }, { GMAIL_USER: "sender@example.com" },
    { GMAIL_APP_PASSWORD: "" }, { GMAIL_APP_PASSWORD: "abcd\nefghijklmnop" }, { GMAIL_SENDER_NAME: "x\r\nBcc: bad" }, { AUTH_ORIGIN: "http://127.0.0.1:3000" }]) {
    expect(() => readGmailConfiguration({ ...environment, ...override })).toThrow("temporarily unavailable");
  }
});

it("uses fixed Gmail TLS, bounded sockets, no content logging and no file/URL loading", () => {
  const delivery = createGmailRecoveryDelivery(environment);
  expect(mocks.createTransport).toHaveBeenCalledWith(expect.objectContaining({ host: "smtp.gmail.com", port: 465, secure: true,
    logger: false, debug: false, disableFileAccess: true, disableUrlAccess: true,
    tls: { rejectUnauthorized: true, servername: "smtp.gmail.com", minVersion: "TLSv1.2" } }));
  expect(mocks.verify).not.toHaveBeenCalled(); expect(mocks.sendMail).not.toHaveBeenCalled();
  delivery.close(); expect(mocks.close).toHaveBeenCalledOnce();
});

it("checks provider readiness without sending an email", async () => {
  await createGmailRecoveryDelivery(environment).ready();
  expect(mocks.verify).toHaveBeenCalledOnce(); expect(mocks.sendMail).not.toHaveBeenCalled();
});

it.each(["reset-password", "verify-email"] as const)("sends one bounded plain-text %s link from the configured mailbox", async (purpose) => {
  const input = message(purpose);
  await createGmailRecoveryDelivery(environment).send(input);
  const mail = mocks.sendMail.mock.calls[0]![0];
  expect(mail).toMatchObject({ from: { name: "Fixture Sender", address: environment.GMAIL_USER },
    envelope: { from: environment.GMAIL_USER, to: [recipient] } });
  expect(mail.text).toContain(input.url);
  expect(mail.text).toContain(purpose === "verify-email" ? "1440 minutes" : "30 minutes");
  expect(mail).not.toHaveProperty("html"); expect(mail).not.toHaveProperty("attachments");
});

it("rejects header/address-list injection and links outside the configured purpose/origin", async () => {
  const input = message();
  const delivery = createGmailRecoveryDelivery(environment);
  for (const override of [{ email: "a@example.com,b@example.com" }, { email: "a@example.com\r\nBcc: b@example.com" },
    { url: input.url.replace("127.0.0.1", "attacker.example") }, { url: input.url.replace("/reset-password", "/verify-email") },
    { url: input.url.replace("#token=", "?token=") }, { url: input.url + "&extra=1" }]) {
    await expect(delivery.send({ ...input, ...override })).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
  }
  expect(mocks.sendMail).not.toHaveBeenCalled();
});

it("sanitizes SMTP failures without retrying a possibly delivered message", async () => {
  const delivery = createGmailRecoveryDelivery(environment);
  mocks.verify.mockRejectedValueOnce(new Error("private SMTP auth detail"));
  await expect(delivery.ready()).rejects.toThrow("temporarily unavailable");
  mocks.sendMail.mockRejectedValueOnce(new Error("private token and mailbox"));
  await expect(delivery.send(message())).rejects.toThrow("temporarily unavailable");
  expect(mocks.sendMail).toHaveBeenCalledOnce();
});

it("fails when SMTP does not accept the intended recipient", async () => {
  mocks.sendMail.mockResolvedValue({ accepted: [], rejected: [recipient] });
  await expect(createGmailRecoveryDelivery(environment).send(message())).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
});
