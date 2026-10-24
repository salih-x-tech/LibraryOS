# Security design

Status: design for approval. Sources: [SRS.md](SRS.md) and [PERMISSIONS.md](PERMISSIONS.md). Privacy, support and operational decisions D02–D09 remain **PENDING APPROVAL**.

## Threat model

Protect credentials, sessions, patron contact/history, inventory, entitlements and audit integrity. Browsers, identifiers, uploads, email links, job payloads and provider callbacks are untrusted. Threats include outsiders, malicious patrons, overreaching staff, compromised platform users and accidental unscoped queries.

| Threat | Required control/evidence |
| --- | --- |
| Cross-tenant or branch ID substitution | Scoped access and same-tenant references; negative tests for endpoints, joins, exports and jobs |
| Privilege or patron ownership escalation | Backend capability AND scope checks; bounded delegation; no client-authoritative roles |
| Credential stuffing/session theft | Strong hashes, secure cookies, revocation, shared limits, generic recovery errors |
| CSRF/XSS | Session-bound CSRF token and Origin checks; escaping and CSP |
| NoSQL injection/mass assignment | Typed allowlists; no raw client queries or update operators |
| Double issue/quota bypass | Transactions, conditional writes, unique indexes and parallel tests |
| Hostile uploads | Scoped signatures, validated content, MIME/size restrictions |
| Job replay/support abuse | Leases, idempotent transitions, explicit platform powers and protected audit |
| Data loss | Backups, isolated restore drills and incident monitoring |

## Authentication and session flow

Hash passwords with Argon2id through a maintained implementation; benchmark and record parameters on deployment hardware before release. Never log passwords/hashes or store reversibly encrypted passwords. Password policy and privileged MFA policy are **PENDING APPROVAL** D02/D07; MFA is recommended for Owners/platform staff.

Verification/recovery tokens are random, hashed at rest, purpose-bound, expiring and single-use. Atomically consume them and check expiry independently of TTL deletion. Password reset revokes relevant sessions. Verified account linking must not rely solely on matching contact email. Activation, claim flow and sensitive-action reauthentication policy are **PENDING APPROVAL** D02–D03.

Login verifies credentials and issues an opaque high-entropy cookie token while storing only its hash. Use Secure, HttpOnly, SameSite=Lax, Path=/ and no Domain; prefer a __Host- cookie name. Rotate sessions at login and sensitive changes; check session/user status and expiry on every protected request. The user approved this scoped D02 policy on October 19, 2026: only status active with verified email may log in; every other state is denied. Sessions have an 8-hour absolute lifetime, 30-minute idle timeout and a maximum of 3 concurrent browser sessions; a new login revokes the oldest when needed. Logout revokes the current browser family including rotated tokens and clears its cookie; successful password reset revokes all user sessions. Rotation never extends the original absolute deadline. Public registration stays disabled until its later review. Other activation/claiming, password-policy and recovery decisions remain **PENDING APPROVAL** D02. Cookies never contain authoritative tenant permissions.

## Authorization and browser defenses

Scoped activation/recovery policy was approved October 20, 2026: existing pending_verification accounts may verify with a 24-hour token; only active verified accounts may reset with a 30-minute token. Reissue invalidates older tokens of the same purpose; reset invalidates all action tokens and browser sessions, then requires normal login. Verification/recovery requests share the approved recovery budget. Each completion purpose has an independent 30/IP/15-minute budget. New passwords require 15–128 Unicode code points, exact-byte handling, a required local common/compromised blocklist and account/service-specific rejection, without forced character mixtures or periodic changes. Existing login validation remains compatible. See AUTH_RECOVERY_POLICY_PROPOSAL.md for the accepted scope. Implementation is restricted to synthetic fixtures with in-memory delivery; real-user endpoints, usable delivery, blocklist release evidence and other D02/D09 decisions remain gated.

Apply PERMISSIONS.md in services, including Server Component reads, reports and jobs. Critical transactions touch shared authorization guards. Scope all tenant data access and joins; global operations use explicitly separate services. Deny support tenant-content inspection/impersonation until D07 approval.

Require session-bound CSRF tokens and same-origin Origin validation for cookie-authenticated mutations, including login/logout where applicable. GET has no business side effects. SameSite alone is insufficient. Reject unsupported cross-origin credentialed requests. Future provider webhooks use verified signatures, not browser CSRF.

Validate IDs, sizes, enums, date ranges and pagination; reject query operators/prototype keys. Escape user text; descriptions remain plain text unless a reviewed sanitizer is introduced. Use CSP, frame restrictions, HTTPS/HSTS and secure headers. Do not fetch arbitrary user-controlled URLs; allowlist provider hosts to prevent SSRF. Use safe DTOs and sanitized errors with request IDs, not stack traces or MongoDB exception messages.

## Distributed rate limits and uploads

Rate-limit login, registration, token verification, recovery, invitations, search, reports, uploads and costly mutations across all web replicas. Combine IP/account/session/tenant keys where appropriate without revealing account existence. Per-process memory is insufficient in production. Return 429/Retry-After. The user approved MongoDB-backed shared authentication limits and fail-closed 503 behavior on October 19, 2026: login permits 5 failed attempts/account/15 minutes and 30 attempts/IP/15 minutes; registration and recovery each permit 5 requests/IP/hour and 3 requests/account/hour. Pending login verifications temporarily reserve failure capacity, with exactly-once refunds on success. See DEVELOPMENT.md for the implemented window/protocol details. Thresholds for other operations, trusted ingress/IP extraction, deployment and other D09 choices remain **PENDING APPROVAL**. No authentication route is enabled solely by this infrastructure approval.

Authorize tenant/purpose before issuing constrained expiring Cloudinary upload signatures. Validate actual provider metadata/content and completion ownership, not supplied MIME alone. Allowlist image formats and byte/dimension limits; reject active formats such as SVG unless separately reviewed. Never permit arbitrary provider asset IDs for update/delete. Bind verified assets to tenant records and clean abandoned uploads through scoped jobs. Folder naming is not authorization. Public-cover versus sensitive-asset delivery policy and exact caps are **PENDING APPROVAL** D08.

## Audit, secrets and privacy

Audit administrative, permission, inventory, circulation, fine and subscription mutations with actor/system identity, tenant/branch scope, action, resource, timestamp, request ID and minimal sanitized changes. Commit required audit alongside business changes. No public edit/delete endpoints. Restrict runtime database audit privileges where practical; controlled migration/retention identities remain separate. This provides tamper resistance, not immunity to database administrator changes.

Keep raw tokens, passwords/hashes, URIs, secrets, full request bodies and unnecessary contact data out of logs. Use deployment secret storage, never source control or NEXT_PUBLIC secrets. Separate environment credentials and least-privilege database/provider users; restrict Atlas network access, rotate keys and protect backups equally.

Retention, export/deletion, minor/patron privacy, consent wording, notification preferences and backup deletion expectations are **PENDING APPROVAL** D08. Do not delete circulation/audit history by assumed policy. This design does not itself establish legal compliance.

## Worker and operational security

Recovery-intent policy was approved October 22, 2026: two-minute leases, no automatic resend/requeue, expired claims or ambiguous delivery outcomes become uncertain, pending intents expire at 24 hours, terminal transitions erase encrypted email payload, and terminal queue metadata is deleted after seven days. These scoped rules do not delete audit records, users, circulation history or backups. Only explicit audited lifecycle primitives are implemented/tested so far; no live scheduler/worker is active. Other D08/D09 retention and notification retry decisions remain pending. See RECOVERY_WORKER_POLICY_PROPOSAL.md for the accepted boundary and SMTP crash/acknowledgment limitations.

Workers atomically claim leases with unique lease tokens; only the current holder finalizes. Expired leases recover after crashes; domain transitions remain idempotent. External delivery is at-least-once: use provider idempotency when available, but acknowledge that a crash after send and before acknowledgment can duplicate email. Cap retries, back off and expose failed deliveries to authorized operators without logging content. Notification failures never roll back committed loans.

Separate development/staging/production, credentials, Cloudinary scopes and email configuration. Use TLS and encrypted managed storage/backups. Restore into isolated environments, disable real email on restored jobs and verify indexes, counters and circulation invariants. Hosting, region/residency, RPO/RTO, backup frequency, alert routing and incident ownership are **PENDING APPROVAL** D09. Monitor latency/errors, transaction conflicts, counter drift, failed jobs and delivery backlog.

## Release verification

Require tenant/branch/ownership denial tests, CSRF/XSS/injection cases, session revocation/recovery tests, concurrent integrity/quota tests, upload abuse tests, secret/dependency scanning and response/log redaction review. Verify platform access denial and a real restoration exercise. Close critical security/integrity findings before pilot; approval thresholds remain D09.

## Phase 3 scoped review — October 24, 2026

Request HTTP admission now commits encrypted intent/audit before HTTP 202 and never looks up users or initializes Gmail. Its local-only switch is independent of completion; strict Origin, purpose CSRF, bounded JSON and email-only fields apply. This establishes an account-independent execution path, not a statistical timing guarantee or proof of eventual delivery. Independent signing/limiter/encryption keys are required. Worker/runtime construction sends nothing; explicit processing can send and is gated separately. No timer, resend loop or public operator endpoint was added.

Own-profile editing permits only optional displayName. It never accepts identity, email, password, status, version or role fields. Session/user guards serialize edits with revocation/reset; required audit rolls back together with the edit. Audit records omit the display-name value. Output is explicitly projected; React renders the name as text. Browser tests verify persistence/accessibility, and integration tests verify self-scope, revoked-session denial and audit rollback.

This is a scoped implementation review with synthetic tests, not full release acceptance. Live Gmail/recipient acceptance, reviewed blocklist provenance and coverage, key/backup retention, real deployment readiness and operational cleanup execution remain outstanding. The local readiness check found those credential/list/key settings missing. See PHASE_3_HANDOFF.md. No Phase 4 capability or tenant authority was added.
