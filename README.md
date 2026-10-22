# LibraryOS

LibraryOS is a multi-tenant library management SaaS. Phases 1–2 and authentication through Task 3.3 are implemented: public shell, database infrastructure, scoped queries, transactional audit/outbox, durable idempotency and local HTTPS login/logout. The accessible sign-in page is at `/login`; activation/recovery and library domain workflows remain upcoming. Atlas schema deployment has not been performed; see [database development](docs/DEVELOPMENT.md).

## Prerequisites

- Node.js 24.18.0 (see `.nvmrc`); supported project range: >=24.18.0 and <25.
- npm 11.16.0; supported project range: >=11.16.0 and <12.

Use npm consistently so `package-lock.json` remains the single dependency lockfile. Direct versions are pinned. TypeScript 5.9.3 is intentionally used within the supported Next.js lint-toolchain range; the newest TypeScript major is not assumed compatible.

A clean `npm ci --offline --no-audit --no-fund` was verified from the populated local npm cache during Phase 1 review. A machine without that cache needs ordinary network-enabled `npm ci`. Build environments need development dependencies (TypeScript, Tailwind/PostCSS); do not omit them before building.

## Local setup

Run these commands in the project directory:

```powershell
npm ci
npm run dev
```

Open [localhost:3000](http://localhost:3000). Stop the foreground server with Ctrl+C. The public shell still needs no database or provider credentials. Server database access requires MONGODB_URI and MONGODB_DB_NAME in untracked `.env.local` or deployment secrets; empty placeholders are in `.env.example`. Validation is lazy and production requires verified TLS. Never store secrets in `NEXT_PUBLIC_` variables. See [database development](docs/DEVELOPMENT.md).

## Validation and production startup

```powershell
npm run lint
npm run typecheck
npm run build
npm run start
```

`npm run validate` runs lint, type checking, Vitest and production build sequentially. Lint runs separately because `next build` does not run ESLint. Type checking first generates Next.js route types so it also works on a fresh checkout. `npm run start` requires a successful build and uses port 3000; stop any development server using that port first.

For a simple startup check, run the production server in one terminal, then in another:

```powershell
$response = Invoke-WebRequest -Uri http://localhost:3000
$response.StatusCode
$response.Content -match '<title>LibraryOS</title>'
```

Expected: status 200 and True. This is a manual runtime check. For automated tests:

```powershell
npm test
npx playwright install chromium
npm run test:e2e
```

`npm test` runs Node unit tests; `npm run test:watch` watches them. Playwright builds and starts its own production server on loopback port 3101, then runs Chromium smoke tests and stops the server. Keep port 3101 free and stop development servers first to avoid concurrent `.next/` writes. Browser binaries need a separate initial download; they are not installed by `npm ci`. Browser checks run separately from `npm run validate`. See [test boundaries](tests/README.md) for isolation and artifact handling.

Real MongoDB integration checks run separately:

```powershell
npm run test:integration
```

This first runs `npm run test:db:prepare` to cache MongoDB 8.2.6, then starts a temporary loopback replica set. The initial Windows binary download is about 819 MB; subsequent runs reuse the cache. No Atlas URI is read by the fixtures and no paid service is provisioned. The unit suite remains fast and does not start MongoDB. Database integration tests are not included in `npm run validate`.

## Known tooling findings (Task 1.1)

The initial install reports five high-severity affected packages in the development lint dependency chain, all originating from [GHSA-vfj7-8cjw-p6xm in braces](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm). At review on October 19, 2026, the advisory lists no patched version. `npm audit --omit=dev` reports zero runtime dependency findings. This does not mean the entire dependency tree is clean.

ESLint 9.39.5 is deprecated upstream, but the current React, import and accessibility plugins used by `eslint-config-next` do not declare ESLint 10 support. Keep the compatible pinned toolchain until a reviewed update is available. Do not run `npm audit fix --force`: its suggested remediation downgrades the Next.js lint configuration across major versions. Recheck before enabling CI on untrusted input or preparing a deployment. No application input is passed to glob patterns in this scaffold.

The clean install also reports an unapproved `unrs-resolver` postinstall hook. No blanket script approval was granted; lint and builds pass with the installed packages on this Windows environment. Review the hook if another platform needs it. The Codex sandbox may block Turbopack's CSS-worker communication or Playwright's local sockets; approved execution outside the sandbox passed. This is an execution-environment limitation, not a reason to disable build or accessibility checks.

## Structure and scope

- `src/app/`: root layout, startup page and minimal CSS; no tenant data or protected routes.
- `next.config.ts`, `tsconfig.json`, `eslint.config.mjs`: typed runtime and development checks.
- `docs/`: approved SRS and architecture/implementation designs.
- `.next/`, `next-env.d.ts`, `node_modules/` and TypeScript build info are generated and ignored. Do not edit generated files; development, type generation and builds recreate Next.js types.

`src/server/config.ts` validates database settings; `src/server/db/connection.ts` owns the lazy per-process pool. Both are server-only. Later approved tasks add domain services in `src/modules/`, more infrastructure in `src/server/` and jobs in `src/workers/`. Handlers will call scoped services rather than query the database directly. The local auth flow is enabled only through the reviewed HTTPS configuration; tenant capabilities and scope must be enforced before library functionality is enabled.

The shell uses Tailwind CSS 4, locally owned shadcn/ui Button/Card adaptations and Motion with reduced-motion support. It includes desktop/mobile navigation, a keyboard skip link, serif headings and forest-green/gold/ivory tokens. Library tools are labeled as upcoming; no live statistics or patron data is invented. See [UI foundations](docs/UI_FOUNDATION.md) and [source attribution](docs/THIRD_PARTY_NOTICES.md).

Vitest and Playwright provide unit, database integration and browser checks. Browser checks include axe audits, mobile navigation, keyboard focus, reduced motion and 320/768/1440px layouts. These support the accessibility target without certifying full conformance. Mongoose and disposable real-database fixtures are included; tenant domain models/APIs, activation/recovery, billing and library workflows remain deferred.

## Project references

- [Local Gmail delivery setup](docs/GMAIL_SETUP.md) — standalone adapter; real-user recovery remains disabled.

- [Requirements](docs/SRS.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Implementation roadmap](docs/IMPLEMENTATION_PLAN.md)
- [Next.js installation](https://nextjs.org/docs/app/getting-started/installation)
- [Next.js ESLint configuration](https://nextjs.org/docs/app/api-reference/config/eslint)

Work one task at a time. We are in Phase 3, Task 3.4: activation/recovery integration. Task 3.3 local login/logout is complete; recovery request HTTP admission and controlled live acceptance remain pending. Task 3.5 and Phase 4 have not started. Local test acceptance is not production/security release acceptance. The user authorized committing and pushing each completed task on October 20, 2026; deployment remains separate.
