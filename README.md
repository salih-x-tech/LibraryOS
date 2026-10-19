# LibraryOS

LibraryOS is a multi-tenant library management SaaS. The current implementation includes the Phase 1 runtime scaffold and Task 1.2 test-runner setup. Visual design and business modules follow in separate approved tasks.

## Prerequisites

- Node.js 24.18.0 (see `.nvmrc`); supported project range: >=24.18.0 and <25.
- npm 11.16.0; supported project range: >=11.16.0 and <12.

Use npm consistently so `package-lock.json` remains the single dependency lockfile. Direct versions are pinned. TypeScript 5.9.3 is intentionally used within the supported Next.js lint-toolchain range; the newest TypeScript major is not assumed compatible.

## Local setup

Run these commands in the project directory:

```powershell
npm ci
npm run dev
```

Open [localhost:3000](http://localhost:3000). Stop the foreground server with Ctrl+C. No environment variables, database, media account or email provider are required for this task. `.env.example` documents that boundary; future approved settings belong in untracked `.env.local`. Never store secrets in `NEXT_PUBLIC_` variables.

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
$response.Content -match '<h1>LibraryOS</h1>'
```

Expected: status 200 and True. This is a manual runtime check. For automated tests:

```powershell
npm test
npx playwright install chromium
npm run test:e2e
```

`npm test` runs Node unit tests; `npm run test:watch` watches them. Playwright builds and starts its own production server on loopback port 3101, then runs Chromium smoke tests and stops the server. Keep port 3101 free and stop development servers first to avoid concurrent `.next/` writes. Browser binaries need a separate initial download; they are not installed by `npm ci`. Browser checks run separately from `npm run validate`. See [test boundaries](tests/README.md) for isolation and artifact handling.

## Known tooling findings (Task 1.1)

The initial install reports five high-severity affected packages in the development lint dependency chain, all originating from [GHSA-vfj7-8cjw-p6xm in braces](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm). At review on October 19, 2026, the advisory lists no patched version. `npm audit --omit=dev` reports zero runtime dependency findings. This does not mean the entire dependency tree is clean.

ESLint 9.39.5 is deprecated upstream, but the current React, import and accessibility plugins used by `eslint-config-next` do not declare ESLint 10 support. Keep the compatible pinned toolchain until a reviewed update is available. Do not run `npm audit fix --force`: its suggested remediation downgrades the Next.js lint configuration across major versions. Recheck before enabling CI on untrusted input or preparing a deployment. No application input is passed to glob patterns in this scaffold.

## Structure and scope

- `src/app/`: root layout, startup page and minimal CSS; no tenant data or protected routes.
- `next.config.ts`, `tsconfig.json`, `eslint.config.mjs`: typed runtime and development checks.
- `docs/`: approved SRS and architecture/implementation designs.
- `.next/`, `next-env.d.ts`, `node_modules/` and TypeScript build info are generated and ignored. Do not edit generated files; development, type generation and builds recreate Next.js types.

Later approved tasks add domain services in `src/modules/`, infrastructure in `src/server/` and jobs in `src/workers/`. Handlers will call services rather than contain business logic. Authentication, capabilities and tenant scope must be enforced before any protected functionality is enabled.

Tailwind/shadcn/ui/Motion integration and the visual shell follow in Task 1.3. Vitest and Playwright configs/tests are included in Task 1.2. Database and domain dependencies are deferred to their own phases. No public registration, API, authentication stub, billing or library workflow is implemented.

## Project references

- [Requirements](docs/SRS.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Implementation roadmap](docs/IMPLEMENTATION_PLAN.md)
- [Next.js installation](https://nextjs.org/docs/app/getting-started/installation)
- [Next.js ESLint configuration](https://nextjs.org/docs/app/api-reference/config/eslint)

Work one task at a time. Task 1.3 requires user confirmation after Task 1.2. Do not commit or push without explicit approval.
