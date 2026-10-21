import { afterAll, beforeAll, expect, it } from "vitest";
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { request as httpsRequest } from "node:https";
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import { chromium, type Browser } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { expect as browserExpect } from "@playwright/test";
import { startIsolatedDatabase } from "../helpers/database";
import { deployInfrastructure } from "../../../scripts/db/indexes";
import { deployAuthStorage } from "../../../scripts/db/auth";
import { validators } from "@/server/db/validators";
import { hashPassword } from "@/modules/auth/passwords";
import { getUserModel } from "@/modules/auth/user-model";
import { SESSION_COOKIE_NAME } from "@/modules/auth/session-format";
import { AUTH_CHALLENGE_COOKIE_NAME } from "@/server/security/auth-csrf";
import { createAuthCsrfProtection, type AuthPurpose } from "@/server/security/auth-csrf";
import { deployActionTokens } from "../../../scripts/db/action-tokens";
import { createTestRecoveryService } from "@/modules/auth/recovery-service";
import { createMongoRateLimiter } from "@/server/security/rate-limit";
import { createRequestContext, errorResponse } from "@/server/http/responses";
import { ApplicationError } from "@/server/http/errors";

const origin = "https://127.0.0.1:3102";
const email = "browser-fixture@example.com";
const password = "Synthetic browser password 42!";
let fixture: Awaited<ReturnType<typeof startIsolatedDatabase>>;
let server: ChildProcess | undefined;
let browser: Browser | undefined;
let recovery: Awaited<ReturnType<typeof createTestRecoveryService>>;
const deliveries: Array<{ email: string; purpose: string; url: string }> = [];

async function ready(): Promise<void> {
  const ca = readFileSync(".local/https/localhost-cert.pem");
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (server?.exitCode !== null) throw new Error("Isolated HTTPS server exited before readiness.");
    const status = await new Promise<number>((done) => {
      const request = httpsRequest(`${origin}/api/v1/auth/challenge?purpose=login`, { ca, timeout: 2000 }, (response) => {
        response.resume(); done(response.statusCode ?? 0);
      });
      request.on("error", () => done(0));
      request.on("timeout", () => request.destroy());
      request.end();
    });
    if (status === 403) return;
    await new Promise((done) => setTimeout(done, 250));
  }
  throw new Error("Isolated HTTPS server readiness timed out.");
}

beforeAll(async () => {
  await new Promise<void>((done, reject) => {
    const probe = createServer();
    probe.once("error", () => reject(new Error("Auth browser test requires free loopback port 3102.")));
    probe.listen(3102, "127.0.0.1", () => probe.close((error) => error ? reject(error) : done()));
  });
  fixture = await startIsolatedDatabase();
  const connection = await fixture.manager.get();
  await deployInfrastructure(connection);
  await deployAuthStorage(connection);
  await deployActionTokens(connection);
  await getUserModel(connection).create({ normalizedEmail: email, passwordHash: await hashPassword(password),
    status: "active", verifiedAt: new Date(), sessionVersion: 0, authorizationVersion: 0, operationFence: 0 });
  await getUserModel(connection).create({ normalizedEmail: "ui-fixture@example.com", passwordHash: await hashPassword(password),
    status: "active", verifiedAt: new Date(), sessionVersion: 0, authorizationVersion: 0, operationFence: 0 });
  await getUserModel(connection).create({ normalizedEmail: "recover-fixture@example.com", passwordHash: await hashPassword(password),
    status: "active", verifiedAt: new Date(), sessionVersion: 0, authorizationVersion: 0, operationFence: 0 });
  await getUserModel(connection).create({ normalizedEmail: "verify-fixture@example.com", passwordHash: await hashPassword(password),
    status: "pending_verification", sessionVersion: 0, authorizationVersion: 0, operationFence: 0 });
  recovery = await createTestRecoveryService(connection, await createMongoRateLimiter(connection, Buffer.alloc(32, 12)),
    { kind: "synthetic-memory", ready: async () => {}, send: async (message) => { deliveries.push(message); } },
    { origin, blocklist: ["a compromised test passphrase"] });
  // Explicit disposable URI overrides any developer .env.local value. No real accounts.
  server = spawn(process.execPath, [resolve("node_modules/next/dist/bin/next"), "dev", "--webpack", "--hostname", "127.0.0.1",
    "--port", "3102", "--experimental-https", "--experimental-https-key", resolve(".local/https/localhost-key.pem"),
    "--experimental-https-cert", resolve(".local/https/localhost-cert.pem")], {
    env: { ...process.env, NODE_ENV: "development", LIBRARYOS_LOCAL_HTTPS: "1", AUTH_ORIGIN: origin,
      AUTH_CSRF_KEY: randomBytes(32).toString("hex"), AUTH_RATE_LIMIT_KEY: randomBytes(32).toString("hex"),
      MONGODB_URI: fixture.uri, MONGODB_DB_NAME: fixture.databaseName, LIBRARYOS_SYNTHETIC_RECOVERY_UI: "1", AUTH_RECOVERY_COMPLETION_HTTP: "" },
    windowsHide: true, stdio: "ignore",
  });
  await ready();
  browser = await chromium.launch();
});

afterAll(async () => {
  await browser?.close();
  try {
    if (server?.pid && server.exitCode === null) {
      if (process.platform === "win32") await new Promise<void>((done, reject) => {
        execFile("taskkill", ["/PID", String(server!.pid), "/T", "/F"], { windowsHide: true }, (error) => error ? reject(error) : done());
      });
      else server.kill("SIGTERM");
    }
  } finally { await fixture?.stop(); }
});

it("runs actual HTTPS login/logout with private cookies, CSRF denial, generic errors and durable revocation", async () => {
  const context = await browser!.newContext({ ignoreHTTPSErrors: true });
  try {
    const page = await context.newPage();
    await page.goto(origin);
    // Browser fetch supplies the real Origin, fetch metadata and cookie transport.
    const exercise = await page.evaluate(async ({ email, password }) => {
      const challenge = async (purpose: string) => {
        const response = await fetch(`/api/v1/auth/challenge?purpose=${purpose}`);
        return { status: response.status, cache: response.headers.get("cache-control"), body: await response.json() };
      };
      const post = async (purpose: string, body: unknown, csrf?: string) => {
        const response = await fetch(`/api/v1/auth/${purpose}`, { method: "POST",
          headers: { "Content-Type": "application/json", ...(csrf ? { "X-CSRF-Token": csrf } : {}) }, body: JSON.stringify(body) });
        return { status: response.status, text: await response.text(), cache: response.headers.get("cache-control") };
      };
      const denied = await post("login", { email, password });
      const loginChallenge = await challenge("login");
      const wrong = await post("login", { email, password: "incorrect" }, loginChallenge.body.data.csrfToken);
      const unknown = await post("login", { email: "absent@example.com", password: "incorrect" }, loginChallenge.body.data.csrfToken);
      const login = await post("login", { email, password }, loginChallenge.body.data.csrfToken);
      const visibleCookies = document.cookie;
      const logoutChallenge = await challenge("logout");
      return { denied, loginChallenge, wrong, unknown, login, visibleCookies, logoutToken: logoutChallenge.body.data.csrfToken };
    }, { email, password });
    expect(exercise.denied.status).toBe(403);
    expect(exercise.loginChallenge.status).toBe(200);
    expect(exercise.loginChallenge.cache).toBe("no-store");
    expect(exercise.wrong.status).toBe(401);
    expect(exercise.unknown.status).toBe(401);
    expect(JSON.parse(exercise.wrong.text).error).toEqual(JSON.parse(exercise.unknown.text).error);
    expect(exercise.login.status).toBe(200);
    expect(JSON.parse(exercise.login.text).data.user.email).toBe(email);
    expect(exercise.visibleCookies).not.toContain("libraryos");
    const session = (await context.cookies()).find((cookie) => cookie.name === SESSION_COOKIE_NAME)!;
    expect(session).toMatchObject({ secure: true, httpOnly: true, sameSite: "Lax", path: "/" });
    expect(exercise.login.text).not.toContain(session.value);
    const db = (await fixture.manager.get()).db!;
    expect(await db.collection("sessions").countDocuments({ revokedAt: { $exists: false } })).toBe(1);
    expect(JSON.stringify(await db.collection("sessions").find().toArray())).not.toContain(session.value);
    expect(await db.collection("auditEvents").countDocuments({ action: "auth.login" })).toBe(1);
    // A durable audit failure must roll back revocation and preserve credentials.
    await db.command({ collMod: "auditEvents", validator: { $expr: { $eq: [1, 0] } } });
    const failedLogout = await page.evaluate(async (csrfToken) => {
      const response = await fetch("/api/v1/auth/logout", { method: "POST", headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken }, body: "{}" });
      return { status: response.status, body: await response.json() };
    }, exercise.logoutToken);
    expect(failedLogout.status).toBe(503);
    expect(failedLogout.body.error.code).toBe("SERVICE_UNAVAILABLE");
    expect((await context.cookies()).some((cookie) => cookie.name === SESSION_COOKIE_NAME && cookie.value === session.value)).toBe(true);
    expect(await db.collection("sessions").countDocuments({ revokedAt: { $exists: false } })).toBe(1);
    await db.command({ collMod: "auditEvents", validator: validators.auditEvents });
    const logout = await page.evaluate(async (csrfToken) => {
      const response = await fetch("/api/v1/auth/logout", { method: "POST", headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken }, body: "{}" });
      return { status: response.status, text: await response.text() };
    }, exercise.logoutToken);
    expect(logout).toEqual({ status: 204, text: "" });
    expect((await context.cookies()).filter((cookie) => [SESSION_COOKIE_NAME, AUTH_CHALLENGE_COOKIE_NAME].includes(cookie.name))).toEqual([]);
    expect(await db.collection("sessions").countDocuments({ revokedAt: { $exists: false } })).toBe(0);
    expect(await db.collection("auditEvents").countDocuments({ action: "auth.logout" })).toBe(1);
    const throttled = await page.evaluate(async ({ email }) => {
      const challenge = await (await fetch("/api/v1/auth/challenge?purpose=login")).json();
      const statuses: number[] = [];
      let retry: string | null = null;
      // Only the earlier wrong-password attempt used this email's bucket.
      for (let attempt = 0; attempt < 4; attempt++) {
        const response = await fetch("/api/v1/auth/login", { method: "POST", headers: {
          "Content-Type": "application/json", "X-CSRF-Token": challenge.data.csrfToken,
        }, body: JSON.stringify({ email, password: "incorrect" }) });
        statuses.push(response.status); retry = response.headers.get("retry-after");
      }
      return { statuses, retry };
    }, { email });
    // The unknown email attempt used a different account bucket: only one
    // previous failure counts for this email, so a fifth new failure is allowed.
    expect(throttled.statuses).toEqual([401, 401, 401, 401]);
    const limited = await page.evaluate(async ({ email }) => {
      const challenge = await (await fetch("/api/v1/auth/challenge?purpose=login")).json();
      const response = await fetch("/api/v1/auth/login", { method: "POST", headers: {
        "Content-Type": "application/json", "X-CSRF-Token": challenge.data.csrfToken,
      }, body: JSON.stringify({ email, password: "incorrect" }) });
      return { status: response.status, retry: response.headers.get("retry-after") };
    }, { email });
    expect(limited.status).toBe(429);
    expect(Number(limited.retry)).toBeGreaterThan(0);
  } finally { await context.close(); }
}, 120_000);

it("exercises recovery UI with synthetic in-memory transport, fragment cleanup and guarded services", async () => {
  const context = await browser!.newContext({ ignoreHTTPSErrors: true });
  const csrf = createAuthCsrfProtection({ origin, secret: randomBytes(32) });
  const purposes = ["reset-request", "verification-request", "reset-password", "verify-email"];
  try {
    // This bridge lives only in the test process. No recovery HTTP adapter is
    // installed in the application; non-intercepted recovery mutations are 404.
    await context.route("**/api/v1/auth/**", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const purpose = url.pathname.endsWith("/challenge") ? url.searchParams.get("purpose") : url.pathname.split("/").at(-1);
      if (!purpose || !purposes.includes(purpose)) return route.fallback();
      const headers = new Headers(await request.allHeaders());
      const correlation = createRequestContext();
      try {
        if (url.pathname.endsWith("/challenge")) {
          // Chromium routing exposes fetch metadata differently across revisions;
          // the initiator and any Origin must still match this owned page.
          if (new URL(request.frame().url()).origin !== origin || (headers.has("origin") && headers.get("origin") !== origin)) throw new ApplicationError("FORBIDDEN");
          const challenge = csrf.issue(purpose as AuthPurpose);
          await route.fulfill({ status: 200, contentType: "application/json", headers: { "Cache-Control": "no-store",
            "Set-Cookie": `${AUTH_CHALLENGE_COOKIE_NAME}=${challenge.cookie.value}; Secure; HttpOnly; SameSite=Strict; Path=/` },
          body: JSON.stringify({ data: { csrfToken: challenge.token } }) });
          return;
        }
        const nonce = headers.get("cookie")?.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${AUTH_CHALLENGE_COOKIE_NAME}=`))?.slice(AUTH_CHALLENGE_COOKIE_NAME.length + 1) ?? null;
        csrf.assertMutation({ method: request.method(), headers }, nonce, purpose as AuthPurpose);
        const body = request.postDataJSON();
        if (purpose === "reset-request" || purpose === "verification-request") {
          await recovery.request(purpose === "reset-request" ? "reset-password" : "verify-email", body.email, "192.0.2.77", correlation);
        } else await recovery.complete(purpose as "reset-password" | "verify-email", body.token, "192.0.2.77", correlation, body.password);
        await route.fulfill({ status: 200, contentType: "application/json", headers: { "Cache-Control": "no-store" }, body: JSON.stringify({ data: {} }) });
      } catch (error) {
        const response = errorResponse(error, correlation);
        await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: await response.text() });
      }
    });
    const page = await context.newPage();
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.goto(`${origin}/forgot-password`);
    for (const width of [320, 768, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
    }
    await page.getByLabel("Email address").fill("recover-fixture@example.com");
    await page.getByRole("button", { name: "Request a link" }).click();
    await browserExpect(page.getByRole("main").getByRole("status"), await page.getByRole("main").getByRole("alert").textContent() ?? "").toContainText("If the account is eligible");
    const resetLink = deliveries.find((message) => message.email === "recover-fixture@example.com")!.url;
    await page.goto(resetLink);
    await browserExpect(page).toHaveURL(`${origin}/reset-password`);
    expect(await page.locator('meta[name="referrer"]').getAttribute("content")).toBe("no-referrer");
    expect(await page.evaluate(() => window.localStorage.length + window.sessionStorage.length)).toBe(0);
    await page.screenshot({ path: "test-results/recovery-reset-desktop.png", fullPage: true });
    await page.setViewportSize({ width: 320, height: 900 });
    await page.screenshot({ path: "test-results/recovery-reset-mobile.png", fullPage: true });
    await page.getByLabel("New password", { exact: true }).fill("A fresh browser passphrase!");
    await page.getByLabel("Confirm new password").fill("Different confirmation!");
    await page.getByRole("button", { name: "Set new password" }).click();
    await browserExpect(page.getByRole("main").getByRole("alert")).toContainText("do not match");
    await browserExpect(page.getByRole("main").getByRole("alert")).toBeFocused();
    await page.getByLabel("New password", { exact: true }).fill("A fresh browser passphrase!");
    await page.getByLabel("Confirm new password").fill("A fresh browser passphrase!");
    expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
    await page.getByRole("button", { name: "Set new password" }).click();
    await browserExpect(page.getByRole("main").getByRole("status")).toContainText("Your password has been reset");
    await page.goto(resetLink);
    await page.getByLabel("New password", { exact: true }).fill("Another fresh passphrase!");
    await page.getByLabel("Confirm new password").fill("Another fresh passphrase!");
    await page.getByRole("button", { name: "Set new password" }).click();
    await browserExpect(page.getByRole("main").getByRole("alert")).toContainText("invalid or expired");
    await page.goto(`${origin}/login`);
    await page.getByLabel("Email address").fill("recover-fixture@example.com");
    await page.getByLabel("Password", { exact: true }).fill("A fresh browser passphrase!");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await browserExpect(page.getByRole("heading", { name: "Welcome back." })).toBeVisible();
    await page.goto(`${origin}/request-verification`);
    await page.getByLabel("Email address").fill("verify-fixture@example.com");
    await page.getByRole("button", { name: "Request a link" }).click();
    await browserExpect(page.getByRole("main").getByRole("status")).toContainText("If the account is eligible");
    await page.goto(deliveries.find((message) => message.email === "verify-fixture@example.com")!.url);
    await browserExpect(page).toHaveURL(`${origin}/verify-email`);
    await page.getByRole("button", { name: "Verify email" }).focus();
    await page.keyboard.press("Enter");
    await browserExpect(page.getByRole("main").getByRole("status")).toContainText("Your email has been verified");
    await browserExpect(page.getByRole("heading", { name: "Confirm your email." })).toBeFocused();
    expect(pageErrors).toEqual([]);
    // APIRequest bypasses browser routing: prove that the app exposes no real
    // recovery mutation even while synthetic UI is enabled in this fixture.
    expect((await context.request.post(`${origin}/api/v1/auth/reset-password`, { data: {} })).status()).toBe(503);
  } finally { await context.close(); }
}, 120_000);

it("supports accessible responsive sign-in, errors, refresh and keyboard logout", async () => {
  const context = await browser!.newContext({ ignoreHTTPSErrors: true, reducedMotion: "reduce" });
  try {
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(origin);
    for (const width of [320, 768, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    }
    await page.goto(`${origin}/login`);
    for (const width of [320, 768, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
    }
    await page.keyboard.press("Tab");
    await browserExpect(page.getByRole("link", { name: "Skip to content" })).toBeFocused();
    await page.keyboard.press("Enter");
    await browserExpect(page.getByRole("main")).toBeFocused();
    await page.getByLabel("Email address").fill("ui-fixture@example.com");
    await page.getByLabel("Password", { exact: true }).fill("incorrect");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await browserExpect(page.getByRole("main").getByRole("alert")).toContainText("Unable to sign in");
    await browserExpect(page.getByRole("main").getByRole("alert")).toBeFocused();
    await browserExpect(page.getByLabel("Password", { exact: true })).toHaveValue("");
    await page.getByLabel("Password", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await browserExpect(page.getByRole("heading", { name: "Welcome back." })).toBeFocused();
    await browserExpect(page.getByRole("button", { name: "Sign out", exact: true })).toBeVisible();
    await page.reload();
    await browserExpect(page.getByRole("heading", { name: "Welcome back." })).toBeVisible();
    expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
    await page.getByRole("button", { name: "Sign out", exact: true }).focus();
    await page.keyboard.press("Enter");
    await browserExpect(page.getByRole("heading", { name: "Sign in to LibraryOS." })).toBeFocused();
    await browserExpect(page.getByRole("status")).toHaveText("You have been signed out.");
    await page.reload();
    await browserExpect(page.getByRole("button", { name: "Sign in", exact: true })).toBeVisible();
    expect((await context.cookies()).some((cookie) => cookie.name === SESSION_COOKIE_NAME)).toBe(false);
    await page.screenshot({ path: "test-results/auth-sign-in-desktop.png", fullPage: true });
    await page.setViewportSize({ width: 320, height: 800 });
    await page.screenshot({ path: "test-results/auth-sign-in-mobile.png", fullPage: true });
    expect(errors).toEqual([]);
  } finally { await context.close(); }
}, 120_000);
