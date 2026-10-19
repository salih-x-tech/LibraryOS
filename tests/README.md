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

These tests use only the startup page; no database, email, media or production data is configured. Playwright's child process inherits local environment and Next.js loads local environment files: use a dedicated test environment without production credentials. Phase 2 must add disposable test database safeguards before integration tests; this task does not implement database isolation.

Use browser tests for future asynchronous Server Components rather than assuming synchronous rendering covers them. Add domain tests when functionality is approved; do not invent pending business defaults.
