# Phase 3 manual handoff — October 24, 2026

Phase 4 has not started. Phase 3 code now includes local recovery request admission and display-name profile editing. **Phase 3 live recovery acceptance is still incomplete.** Do not mark the phase fully accepted or enable real delivery from synthetic evidence.

## Implemented in this checkpoint

- POST `/api/v1/auth/password-reset-requests` and `/verification-requests` use bounded JSON, exact email-only input, exact Origin and purpose-bound CSRF challenges. They persist encrypted intent plus audit before generic HTTP 202 `{ received: true }`. There is no identity lookup, token issuance or SMTP operation on this path; provider failures cannot select an account-dependent HTTP response.
- `AUTH_RECOVERY_REQUEST_HTTP=1` is separate from completion activation. `AUTH_RECOVERY_UI=1` additionally requires both HTTP switches and approved local HTTPS. Default settings remain disabled. Synthetic browser fixtures retain their isolated bridge.
- `getLocalRecoveryWorker` composes guarded one-job processing and explicit lifecycle operations behind `AUTH_RECOVERY_WORKER=1`. Initialization never verifies SMTP or sends. Calling `worker.processOne(context)` can send; no public operator endpoint, scheduler, automatic retry or polling loop exists. Internal invocations need a fresh server-generated request context. Lifecycle `expireOne`/`purgeOne` remain explicit; no real cleanup timing is promised without a separately reviewed operational runner.
- GET/PATCH `/api/v1/me` and `/account` provide an allowlisted own-account DTO and optional display name (at most 100 characters; empty clears it). PATCH requires a current session-bound CSRF token, exact Origin/JSON, and guarded session/user writes with mandatory transactional audit. Email, password, roles, account IDs and tenant fields cannot be edited here. The user approved display name only on October 24.
- `db:recovery:plan`, `db:recovery:verify` and `db:recovery:apply` expose explicit recovery storage review/deployment. Plan opens no database. Apply/verify require `-- --database <configured-name>` and verified auth prerequisites. No command was used to migrate a real database.

## Readiness check and remaining acceptance

The user authorized a local readiness check **without sending email**. Only boolean readiness results were printed. In `.env.local`, the sender address exists; `GMAIL_APP_PASSWORD`, `AUTH_RECOVERY_QUEUE_KEY`, `AUTH_PASSWORD_BLOCKLIST_PATH`, `AUTH_PASSWORD_BLOCKLIST_SHA256` and `AUTH_PASSWORD_BLOCKLIST_SOURCE` are absent/empty. Other secret stores were not inspected. No SMTP authentication was attempted.

Before full Phase 3 acceptance:

1. Configure the Gmail app password locally. Supply and review a real password blocklist's provenance, license, coverage and refresh policy; pin its exact byte checksum. Synthetic fixture lists are not release evidence.
2. Configure an independent queue encryption key and document backup/key retention. Restart after configuration/key/list changes; runtimes cache successful initialization.
3. Review and explicitly deploy the updated auth validator (optional display name), action tokens and recovery queue to the selected local database. Existing deployments fail readiness until their contracts match. Atlas changes remain separately authorized work.
4. Review recipient/synthetic account and cleanup scope, then explicitly authorize a controlled live send. Exercise request, explicit worker invocation, actual received link, verification/reset, replay rejection, old-session invalidation and new-password login. Record provider acceptance and inbox receipt separately.
5. Review lifecycle execution and operational ownership before allowing live requests to accumulate. No scheduler is activated by this checkpoint.

Do not use real accounts or print recovery links/credentials as a substitute for delivery acceptance. No real email, scheduler, external deployment or Atlas change occurred. Public registration remains disabled under the existing policy. Hosting and production security/release gates remain separate.

## Continuing manually in ChatGPT

Keep the repository at `D:\LibraryOS`. Share this file, IMPLEMENTATION_PLAN.md, GMAIL_SETUP.md and the relevant source files with ChatGPT; never share `.env.local`, tokens or app passwords. Tell it: “Finish only the remaining Phase 3 acceptance gates described in PHASE_3_HANDOFF.md. Do not start Phase 4. Give exact edits/commands for me to run locally. Read installed Next.js documentation before framework changes.”

Run `npm test`, `npm run lint`, `npm run typecheck`, `npm run test:integration`, `npm run test:auth:browser` and `npm run build -- --webpack` as appropriate after edits. Stop Next.js development servers before build/browser commands because they share `.next`. Disposable database/browser tests require permission to launch local processes in restricted environments.
