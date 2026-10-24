# REST API design

Status: proposed contracts for approval, not implemented routes. Sources: [SRS.md](SRS.md), [PERMISSIONS.md](PERMISSIONS.md), [DATABASE_DESIGN.md](DATABASE_DESIGN.md). Business decisions D02–D09 remain **PENDING APPROVAL**.

## Request and response conventions

Prefix `/api/v1`; tenant base `T = /api/v1/organizations/{organizationId}`. IDs are opaque validated ObjectId strings. URL organization selection is not proof of access. Use JSON, UTC ISO-8601 timestamps, integer minor-unit amounts and currency. Reject unknown writable fields, raw MongoDB operators and arbitrary client-selected query objects. Client input never supplies authoritative roles, counters or computed due dates.

Success: `{ "data": {...}, "meta": { "requestId": "..." } }`. Lists use an array in data and nextCursor in meta. Error: `{ "error": { "code": "COPY_UNAVAILABLE", "message": "Copy cannot be issued.", "fields": [] }, "meta": { "requestId": "..." } }`. DTOs omit credentials, tokens, internal exception details and unnecessary patron contact fields.

Statuses: 200 reads/updates/actions; 201 creation with Location; 202 accepted asynchronous work; 204 logout; 400 malformed input; 401 invalid session; 403 denied capability/feature/state; 404 invisible resource; 409 duplicate/version/quota/lifecycle conflict; 422 field or policy validation; 428 missing required edit precondition; 429 rate limit with Retry-After; 500 sanitized unexpected failure; 503 infrastructure unavailable. Stable codes include STALE_VERSION, QUOTA_EXCEEDED and POLICY_NOT_CONFIGURED.

Proposed technical pagination caps: default 25, maximum 100; stable cursor order `(createdAt,_id)` or documented domain order. Bind cursors to tenant, sort and filters; reauthorize every request. Allowlist filters and sorts. Date ranges are `[from,to)`; business calendar/timezone rules are **PENDING APPROVAL** D05. Sensitive responses use Cache-Control no-store.

All cookie-authenticated mutations require CSRF protection. Issue, return, renewal decisions, transfers and quota-consuming creates require Idempotency-Key. Store key/request hashes and result atomically with domain effects, scoped by actor/organization/operation. Same key/body replays recorded status/body; changed body returns 409. Reauthorize before replay. Retention window is **PENDING APPROVAL** D08. Durable lifecycle checks prevent duplicate returns even after key expiry. Editable resources use version ETag/If-Match; stale versions return 409. No direct PATCH of loan status, hold state or counters.

## Endpoint catalogue

Every tenant endpoint additionally enforces active membership, organization state, feature entitlement and branch/ownership scope from PERMISSIONS.md.

| Method/path | Purpose and input | Capability |
| --- | --- | --- |
| POST /auth/register | email/password; activation D02 | Public, limited; pilot registration availability D09 |
| POST /auth/login; POST /auth/logout | credentials/set cookie; revoke/clear cookie | Public limited / current session |
| POST /auth/verification-requests; /auth/password-reset-requests | email; generic response | Public, limited |
| POST /auth/verify-email; /auth/reset-password | single-use token and required fields | Valid token |
| GET /me; PATCH /me | own account / optional displayName only | Self; PATCH requires session-bound CSRF; email/password/privilege edits rejected |
| GET /me/organizations | workspace memberships | Self |
| POST /organizations | name/slug; atomic Owner and Free subscription | Eligible authenticated user; creation policy D09 |
| GET T; PATCH T | workspace / settings | organization.read/update |
| GET/POST T/branches; GET/PATCH T/branches/{id} | branch listing/create/detail/update | branch.read/manage; quota for create |
| GET T/staff | staff directory | staff.read |
| POST T/invitations | email, role, branchIds | staff.invite and delegation ceiling |
| POST /invitations/accept | invitation token | Verified recipient; atomic membership/assignments and quota |
| PATCH T/staff/{id} | approved role/status fields | staff.manage; Owner protection |
| PUT T/staff/{id}/branch-assignments | complete authorized branch ID set | staff.manage |
| PUT T/staff/{id}/capabilities | bounded capability overrides | permissions.configure |
| GET/POST T/members; GET/PATCH T/members/{id} | list/create/detail/update patrons | member.read/create/update; quota for create |
| POST T/members/{id}/account-invitations | begin verified account claim | member.update; D02 flow pending |
| GET T/me/member; GET T/me/loans | linked patron / borrowing history | member.readSelf / loan.readSelf |
| GET/POST T/catalog; GET/PATCH T/catalog/{id} | search/create/detail/update title | catalog.read/manage |
| GET/POST T/copies; GET/PATCH T/copies/{id} | list/create/detail/safe metadata | copy.read/manage; quota for create |
| POST T/copies/{id}/adjustments | approved inventory action and reason | inventory.adjust |
| POST T/transfers | copyId, destinationBranchId, reason | copy.manage at both branches; D04 |
| POST T/transfers/{id}/receive | inspection details | copy.manage at destination; D04 |
| GET T/loans; GET T/loans/{id} | branch-scoped loan data | loan.read |
| POST T/loans | copyId, memberId, issueBranchId | circulation.issue |
| POST T/loans/{id}/return | returnBranchId, inspection | circulation.return; cross-branch rules D04 |
| POST T/loans/{id}/renewal-requests | request renewal | renewal.requestSelf or explicit staff scope |
| POST T/renewal-requests/{id}/decision | approve/reject, reason, version | renewal.decide; D05 approval model |
| GET/POST T/reservations | filters / catalogItemId and approved pickupBranchId | reservation.manage or readSelf/createSelf |
| POST T/reservations/{id}/cancel | reason | reservation.manage/cancelSelf; D04 |
| GET/POST T/policies | list / immutable policy version | policy.read/manage |
| GET T/fines; GET T/me/fines | scoped / own fine ledger | fine.read / fine.readSelf |
| POST T/fines/{id}/adjustments | approved adjustment and reason | fine.adjust; D05 settlement rules |
| GET T/dashboard | authorized role metrics | report.read or dashboard.self |
| GET T/reports/{reportType} | inventory-summary, circulation, overdue, member-activity, popular-books; branch/date filters | report.read |
| GET T/notifications; POST T/notifications/{id}/read | own inbox / mark own item read | notification.readSelf/markSelf |
| GET T/subscription; GET T/usage | entitlements / organization counters | subscription.read / usage.read |
| GET T/audit-events | scoped resource/date/cursor filters | audit.read |
| POST T/media/upload-authorizations; /media/upload-completions | purpose/MIME/size; verified provider reference | Owning module write capability |
| GET /platform/organizations | platform metadata | platform.organizationManage |
| POST /platform/organizations/{id}/suspend | reason | platform.organizationManage; D07 |

For compact rows, every slash-prefixed auth path retains `/api/v1`; tenant paths retain T. Ownership transfer, subscription change administration, fine payments, support inspection, organization export/deletion and suspension recovery contracts are **PENDING APPROVAL** D03/D05–D08. No generic destructive DELETE or automated payment endpoint is offered before those policies are approved. Future billing callbacks require signature verification, replay protection and provider-event uniqueness.

## Issue/return and handler flow

Issue body: `{ "copyId": "<id>", "memberId": "<id>", "issueBranchId": "<id>" }`. Success 201 returns loan id, memberId, copyId, active status, issuedAt, dueAt and version. Competing issue returns 409 COPY_UNAVAILABLE. Return body: `{ "returnBranchId": "<id>", "inspection": { "condition": "<approved value>" } }`; success returns the recorded returned loan and resulting copy state. Condition vocabulary and cross-branch eligibility are **PENDING APPROVAL** D04–D05. Undocumented backdating and fine overrides are rejected.

Handler flow: validate -> authenticate -> trusted context -> application service -> typed error mapping -> DTO. Service owns permissions, policy, transaction and audit. Worker scheduling uses authenticated infrastructure entry points, not public browser endpoints; worker reads remain tenant-scoped. See DATABASE_DESIGN.md for atomic workflows.
