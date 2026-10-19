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

## Phase 2 persistence coverage

The suite now exercises tenant-scoped reads/writes, shared transaction commit/rollback/transient retries, atomic audit/outbox visibility, strict validators and unique/TTL deployment specifications. Durable idempotency tests cover replay/conflict, authorization on replay, tenant/actor/operation/global separation, concurrent calls, expiry before TTL cleanup, rollback across business/audit/outbox/idempotency records, synthetic lost final acknowledgment, and a real driver retry of an injected UnknownTransactionCommitResult after a successful real commit. These fault injections use disposable records and are not a production network-failover certification. All Phase 2 integration collections are provisioned explicitly by the deployment helpers where relevant. No Atlas credentials, outgoing email or business-policy defaults are required.
