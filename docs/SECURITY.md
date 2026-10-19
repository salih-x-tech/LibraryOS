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

Workers atomically claim leases with unique lease tokens; only the current holder finalizes. Expired leases recover after crashes; domain transitions remain idempotent. External delivery is at-least-once: use provider idempotency when available, but acknowledge that a crash after send and before acknowledgment can duplicate email. Cap retries, back off and expose failed deliveries to authorized operators without logging content. Notification failures never roll back committed loans.

Separate development/staging/production, credentials, Cloudinary scopes and email configuration. Use TLS and encrypted managed storage/backups. Restore into isolated environments, disable real email on restored jobs and verify indexes, counters and circulation invariants. Hosting, region/residency, RPO/RTO, backup frequency, alert routing and incident ownership are **PENDING APPROVAL** D09. Monitor latency/errors, transaction conflicts, counter drift, failed jobs and delivery backlog.

## Release verification

Require tenant/branch/ownership denial tests, CSRF/XSS/injection cases, session revocation/recovery tests, concurrent integrity/quota tests, upload abuse tests, secret/dependency scanning and response/log redaction review. Verify platform access denial and a real restoration exercise. Close critical security/integrity findings before pilot; approval thresholds remain D09.
