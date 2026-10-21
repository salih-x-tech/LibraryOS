# Test boundaries

- `unit/**/*.test.ts(x)`: Vitest with Node, explicit imports, per-file isolation and restored mocks. The current smoke test renders the real synchronous startup component and verifies the `@/` alias/TSX pipeline. No DOM library is needed yet.
- `e2e/**/*.spec.ts`: Playwright with fresh browser contexts and Chromium. It builds and starts a production server on `127.0.0.1:3101`, refuses to reuse another process, and stops its server afterward. Keep that port free; stop development servers before this suite because both commands write `.next/`.

The runners discover separate test folders. `forbidOnly` prevents focused browser tests; retries are disabled so failures stay visible. Failure traces/screenshots go in ignored `test-results/`. Review locally; do not commit sensitive artifacts.

```powershell
npm test
npm run test:watch
npx playwright install chromium
npm run test:e2e
```

Install Chromium once per machine and after browser revision updates. Linux CI may also require browser OS libraries. Browser binaries and runners are development tooling.

Browser tests use the shell; no email, media or production data is configured. Playwright's child process inherits local environment and Next.js loads local environment files: use a dedicated test environment without production credentials. Database integration tests have their own fixture/configuration described below.

Use browser tests for future asynchronous Server Components rather than assuming synchronous rendering covers them. Add domain tests when functionality is approved; do not invent pending business defaults.

Task 1.3 adds axe checks at mobile/tablet/desktop widths, an overflow check, skip-link focus, mobile disclosure/Escape/section navigation and reduced-motion behavior. Full-page shell screenshots are generated under `test-results/` for visual review. Axe is development-only and its passing checks do not replace manual keyboard, screen-reader and final release accessibility reviews.

## Database tests — Task 2.1

`npm run test:integration` prepares the pinned real MongoDB binary before starting `vitest.integration.config.ts`. Only `integration/**/*.test.ts` is discovered; unit tests remain separate. Preparation avoids first-download test-hook timeouts. A single worker runs loopback WiredTiger replica sets with generated database names, owned pools and guarded cleanup. No caller-provided application URI can become a cleanup target. See [database development](../docs/DEVELOPMENT.md).

`server-only` is a Next.js compiler marker; Vitest substitutes tests/helpers/server-only.ts solely inside test resolution. Production imports retain the real marker. Application database access is disabled for NODE_ENV=test, requiring an explicit isolated fixture. Unit lifecycle tests mock the connection to inject failures; integration tests verify actual MongoDB behavior, including transaction rollback.

## Local HTTPS authentication browser checks

Run `npm run auth:local:setup` and `npx playwright install chromium` once, then `npm run test:auth:browser`. Stop other Next.js servers/builds first and leave loopback port 3102 free. This separate Vitest configuration runs a real Chromium browser against a Next HTTPS development server using the supported webpack builder; the ordinary database suite excludes it. It requires the local generated certificate/key but never reads private auth settings. A readiness probe trusts only that certificate; the isolated browser context accepts the self-signed certificate without installing machine trust.

The fixture creates an owned disposable MongoDB replica set, explicitly deploys infrastructure/auth storage and inserts synthetic verified accounts. It passes only that fixture URI/database to the child server, overriding local database settings, and generates fresh signing keys. It closes Chromium, stops its owned server process tree and removes the disposable database process on completion. It refuses an occupied port instead of reusing another server. The test checks actual browser fetch metadata, CSRF denial, generic credential failures, secure HttpOnly cookie transport, safe DTOs, audited login/logout, audit-failure rollback and cookie preservation, and real account throttling with Retry-After. No traces containing credentials are saved. The second test exercises the /login UI: responsive layouts, axe scans, keyboard skip-link/error/success focus, password clearing on failure, refresh persistence and keyboard logout. Signed-out desktop/mobile screenshots are written to ignored test-results for visual review.

The auth browser suite also runs synthetic recovery UI acceptance. It creates separate active/pending synthetic users and an in-memory delivery sink. Browser routing intercepts only recovery challenge/mutation requests and forwards them to the real guarded test service; it does not install an application recovery endpoint. Checks cover request feedback, responsive axe scans, fragment/query cleanup without web storage, confirmation mismatch/focus, reset, replay rejection after same-page navigation, new-password login and keyboard email verification. A non-intercepted HTTP reset request returns disabled 503; email-request endpoints remain absent. Screenshots show only empty forms and are ignored. The synthetic UI flag is restricted to local launcher/test-database configuration; production stays unavailable even if that flag is set.

## Phase 2 persistence coverage

The suite now exercises tenant-scoped reads/writes, shared transaction commit/rollback/transient retries, atomic audit/outbox visibility, strict validators and unique/TTL deployment specifications. Durable idempotency tests cover replay/conflict, authorization on replay, tenant/actor/operation/global separation, concurrent calls, expiry before TTL cleanup, rollback across business/audit/outbox/idempotency records, synthetic lost final acknowledgment, and a real driver retry of an injected UnknownTransactionCommitResult after a successful real commit. These fault injections use disposable records and are not a production network-failover certification. All Phase 2 integration collections are provisioned explicitly by the deployment helpers where relevant. No Atlas credentials, outgoing email or business-policy defaults are required.
