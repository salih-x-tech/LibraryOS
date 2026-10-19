# Server configuration and database development

Phase 2 provides server configuration, pooled connections, response/logging helpers, transaction execution, tenant-required query primitives, audit/outbox persistence and durable idempotency. Authentication, membership resolution, domain collections/policies and API endpoints remain later phases. See [database design](DATABASE_DESIGN.md) for domain work.

## Server-only configuration

Put local secrets in untracked `.env.local`, or use a deployment secret manager. The checked-in `.env.example` contains empty placeholders. The public UI builds and runs without a database: validation happens only when server code requests a connection.

| Variable | Contract |
| --- | --- |
| MONGODB_URI | Required MongoDB connection string when using the database; maximum 4096 characters; parsed without opening a connection |
| MONGODB_DB_NAME | Required explicit database name; 1–63 lowercase letters/digits/underscores, starting with a letter; overrides any URI database path |
| NODE_ENV | Standard development/test/production values; Next.js supplies it for app commands; unsupported values are rejected |

Production requires TLS with certificate and hostname verification. The driver defaults SRV connections to TLS; standard MongoDB URIs must enable TLS explicitly in production. The validator checks normalized driver options, including rejectUnauthorized and checkServerIdentity, rather than assuming URI option names survive normalization. Invalid configuration errors never include the URI, credentials, original parser errors or a sensitive cause.

Do not print the returned config object: its URI is a secret. The module imports the real `server-only` build marker so client imports fail in Next.js. Vitest replaces that marker only in its own test configuration; it does not change the production boundary. Tests do not load a real Atlas credential.

## Connection lifecycle

`src/server/db/connection.ts` provides lazy `getDatabaseConnection()` and explicit `closeDatabaseConnection()` for process shutdown/tool teardown. A process-level cache shares one manager across development reloads. Never close the pool after each request. Environment/credential changes require a process restart.

Within a manager, simultaneous callers share the same initial connection attempt. Failed startup is cleaned up and can retry. Close waits for startup; a get during close waits before reopening. Failed shutdown retains pool ownership so a close can retry without creating another potentially overlapping pool. Driver reconnection after a temporary outage remains the driver's responsibility; the wrapper does not create a second pool on every disconnected event.

Technical defaults: maxPoolSize=10, minPoolSize=0, 5-second server-selection/connect/wait-queue bounds, majority writes, buffering off, autoCreate=false and autoIndex=false. These are initial infrastructure settings, not approved performance SLAs. Pool capacity is per web process and must be measured under the final deployment profile. Deploy collections/validators/indexes explicitly in the later task; no production startup synchronization.

Opening/closing errors are sanitized DatabaseConnectionError instances. Raw emitter details are not logged. Structured error mapping, request IDs and operational logging belong to Task 2.2; transaction orchestration belongs to Task 2.3. This module is an internal server primitive, not a tenant authorization boundary: later scoped services must enforce organization/branch permissions before queries. No route may bypass them by directly exposing the connection.

## Unit and real-database tests

```powershell
npm test
npm run test:db:prepare
npm run test:integration
```

Unit tests validate configuration, TLS enforcement, safe errors, pool sharing/retry/close races and test-mode blocking. They need no database. The normal unit include pattern does not discover integration tests.

Integration tests use mongodb-memory-server-core, which downloads/launches an actual MongoDB binary rather than mocking the database. The core package has no automatic MongoDB download install hook. MongoDB 8.2.6 is pinned as a test-server version; this does not select a production Atlas version or provision a paid service.

`test:integration` first prepares/caches the binary, then starts Vitest. A first Windows download is about 819 MB, requires network access and may take several minutes. Preparation occurs before test hooks so network time cannot masquerade as a fixture timeout. Subsequent runs use the local binary cache. The package checks the downloaded archive; no TLS/checksum bypass is configured. Keep the cache outside source control. The process requires permission to start local child processes and bind loopback sockets.

The fixture:

- Requires NODE_ENV=test and creates its own WiredTiger single-node replica set bound to 127.0.0.1 on a generated port.
- Generates a unique libraryos_test_ database name; accepts no external URI or caller-supplied connection for cleanup.
- Never reads MONGODB_URI/MONGODB_DB_NAME from the application environment. The ordinary application accessor also refuses to run in test mode.
- Owns a separate connection manager; clear() checks name, prefix, host and port before dropping only its generated database.
- Closes its manager and stops its own temporary server during teardown, including failed setup paths where applicable.

Integration probes use synthetic connection_probes documents, not business models. Tests demonstrate a real transaction commit/rollback, shared connection use, guarded cleanup and two fixtures that cannot clear one another's records. They do not prove future tenant service isolation or implement the circulation transaction workflow.

The test-only server marker replacement is in tests/helpers/server-only.ts. Explicit `.ts` config/helper imports work with Node 24 native TypeScript and Vite's native loader; tsconfig enables allowImportingTsExtensions with noEmit. No TypeScript strictness was relaxed.

## Validation commands and boundaries

`npm run validate` remains lint + type checking + unit tests + production build. Database integration and browser suites are separate explicit commands; do not claim validate runs them. In environments restricting sockets/child processes, Turbopack and the real database/browser tests may require permitted execution outside that sandbox. Do not disable test assertions or substitute production credentials to make them pass.

Real Atlas provisioning, credentials, network allowlists and operational deployment choices remain PENDING APPROVAL D09. Before using an Atlas environment, verify replica-set/transaction support and use least-privilege credentials. This task never connects to a real organization database.

## HTTP foundation — Task 2.2a

Use src/server/http/responses.ts at future API boundaries. Create one context with createRequestContext() per request and reuse it for the response and later safe logs. The ID is generated on the server rather than copied from untrusted headers. successResponse returns 200; createdResponse returns 201 and requires a local /api/v1/ resource Location. Both include the data/meta envelope, JSON content type, X-Request-Id and Cache-Control: no-store.

Project database results into explicit DTOs containing only authorized public fields before calling these helpers. JsonValue restricts serialization types; it does not detect passwords or provide authorization. Do not pass raw Mongoose documents, request bodies or database results directly.

Throw ApplicationError with an allowlisted code for a known public failure. Messages are fixed by code, never taken from input or exception text. errorResponse maps DatabaseConnectionError to a generic 503 and unrecognized exceptions to a generic 500. Field details are empty unless supplied through FieldValidationError as described below. Do not classify arbitrary MongoDB errors as domain conflicts without operation-specific service logic.

These helpers expose no routes and enforce no authentication themselves. Future handlers must retain the documented validation/authentication/service/DTO boundaries. Task 2.2 provides response/pagination/logging primitives; each future endpoint still needs domain-specific validation and authorized integration.

## Pagination foundation — Task 2.2b

src/server/http/pagination.ts implements the documented technical defaults: 25 records by default, maximum 100. Invalid sizes are rejected rather than silently clamped. readPaginationParams rejects duplicate limit/cursor parameters, empty cursors and cursors over 2048 characters; domain handlers must separately reject unknown query parameters and validate allowlisted filters/sorts.

The cursor codec uses HMAC-SHA256 and accepts an injected secret of at least 32 bytes. Production route integration must supply a cryptographically random, persistent secret from server configuration, shared across replicas; secret provisioning/rotation is not implemented by this helper. Never use the deterministic test key in an application. Rotation invalidates existing cursors. Tokens are signed, not encrypted: they contain a timestamp/ObjectId position and scope digest; put no private data in positions. Never log raw cursor values.

Cursors bind to organizationId, resource, createdAt/_id sort direction, and normalized filters. Services must construct scope from validated values and trusted authorization context, including branch restrictions and other effective visibility predicates. Filter key ordering is canonicalized; values must already be normalized. Decode only accepts canonical UTC timestamp and lowercase ObjectId positions. No cursor establishes authorization: reauthorize every request, and build tenant/branch predicates independently of decoded position.

For this generic order, services sort both createdAt and _id in the same direction. Ascending continuation uses createdAt > timestamp OR (createdAt = timestamp AND _id > id); descending uses < for both comparisons. Combine that condition with mandatory visibility predicates, never replace them. Fetch limit + 1, pass results through slicePage, and encode the last returned row only when hasMore is true. Empty/final pages use nextCursor: null through listResponse. Use matching compound indexes when domain queries are introduced. No MongoDB query builder, index or route is included in this task. Pagination does not promise snapshot isolation across requests; concurrent inserts/removals can change the visible dataset.

## Validation, remaining responses and operational logs — Task 2.2c

FieldValidationError accepts a server-declared list of simple schema field names and 1–50 issues. Each issue contains only field and one fixed code: REQUIRED, INVALID, TOO_LONG or OUT_OF_RANGE. The error copies and freezes these projections; extra properties, submitted values and validator messages are excluded. Never derive allowedFields from request keys. Unknown writable fields should produce a generic BAD_REQUEST rather than echoing their names. Domain validators remain responsible for detecting invalid input, operator/prototype keys and unknown fields; this class only formats safe details.

acceptedResponse returns the JSON envelope with status 202. noContentResponse returns status 204 with no body/content type; logout must separately revoke the session and clear its cookie. RateLimitError requires a positive safe integer retry delay supplied by a real limiter decision; errorResponse returns 429 with Retry-After seconds. A bare ApplicationError(RATE_LIMITED) becomes a generic 500 because its required retry information is absent. No rate limiter or thresholds are configured here; distributed enforcement/provider/failure policy remain PENDING APPROVAL D09.

createLogger in src/server/logging.ts writes one JSON line to an injected sink (console.info by default). Allowed events are request.completed, request.failed and database.unavailable; allowed metadata is a server-generated UUID requestId plus optional status, durationMs and public errorCode. Runtime checks reject invalid retained values, and explicit projection drops all unknown properties rather than attempting to redact arbitrary objects recursively. Do not log raw errors, credentials, headers, URLs, query strings, cursor values, contact data, request bodies or free-form messages. Add future event types explicitly with focused redaction tests. The logger is an operational primitive, not the durable domain audit trail planned in Task 2.4.

Sink exceptions are contained without logging the raw sink failure, so logging cannot induce retries of a successful business operation. Deployment monitoring must independently detect log delivery failures; no delivery guarantee or telemetry backend is implemented. Future request handlers must deliberately integrate these helpers after the authentication/service boundaries exist; current public UI behavior is unchanged.

## Shared transaction execution — Task 2.3a

runTransaction(connection, work) in src/server/db/transaction.ts requires an explicitly supplied connection and passes one session through an immutable context. It never reads application credentials. It uses Mongoose Connection.transaction, primary/snapshot reads, majority writes and a 15-second driver transaction execution/retry budget. This technical budget is not an API SLA and does not forcibly interrupt arbitrary JavaScript or external calls. Mongoose forwards timeoutMS to the driver's withTransaction; its narrower declared TransactionOptions type is extended structurally without casts or disabling strict typing.

Execute database operations sequentially and explicitly attach the session to every operation, including reads. Do not use Promise.all inside transactions. Do not manually commit, abort or end the owned session, nest this helper, swallow driver failures, or invoke external email/payment/HTTP effects inside its retryable callback. The callback can execute more than once: compute state again on each attempt and persist audit/outbox/idempotency effects in that same session when their helpers are available. Mongoose owns session cleanup and resets tracked document state on rollback.

The driver owns bounded transient retries and unknown-commit handling; this helper adds no outer retry. ApplicationError business rejections pass through unchanged. All other failures become sanitized SERVICE_UNAVAILABLE without a raw cause. A final failure does not prove an ambiguous commit rolled back. Future mutation services must use the planned durable idempotency protocol before enabling automatic/client retries. No ambiguous-commit fault injection or idempotency resolution is claimed in this slice.

This execution helper does not authenticate, select a tenant, enforce branch permissions or touch revocation guards. Task 2.3b adds scope primitives; actual membership resolution, authorization fences and domain invariants belong to their documented module phases. No domain mutation or API is enabled by this infrastructure.

## Tenant-required query conventions — Task 2.3b

createTenantScope validates a canonical lowercase ObjectId and freezes the selection. tenantFilter composes the mandatory organizationId with an internal service-built predicate using $and, so a conflicting organizationId or broad $or cannot override the tenant boundary. requireTenantReference hides foreign references with NOT_FOUND. These are data-access primitives, not proof of authenticated membership. Services must resolve current identity/membership/permissions before constructing scope. Never accept a scope object or MongoDB predicate from a request. There is no implicit global bypass: global repositories are separate, and only the audit/idempotency persistence contracts accept an explicit global discriminant.

All tenant CRUD, aggregation first-match stages and joins still need these constraints deliberately integrated by future modules. Updates must allowlist writable fields and reject changes to organizationId; query scoping alone does not prevent a malicious update from moving a document. Branch/self restrictions remain additional predicates; reject unauthorized filters rather than broadening access. Phase 4/5 adds trusted resolution and transactional revocation fences; none is claimed complete by this helper.

## Transactional audit/outbox — Task 2.4

appendAudit and publishOutbox require an active transaction context and attach its session to writes. Call sequentially with domain writes. They construct explicit projections and use connection-local Mongoose models, strict schemas, timestamps, disabled automatic creation/indexes, and no implicit version counters. The outbox payload sub-schema also disables its unused version key; real rollback/retry tests cover Mongoose document restoration.

Audit scope is explicitly tenant or global; tenant scope stores organizationId plus scopeKey tenant:<ObjectId>, while global scope has scopeKey global and no organizationId. Actor is one userId or systemIdentity. Use fixed server-defined action/resource/change labels; changedFields records field names without old/new patron values. The append helper exposes no audit update/delete API. Database operators with broad administrative access can still change records; production audit access controls and retention remain operational work under D08/D09. No audit TTL is deployed.

Outbox events require tenant scope, unique organizationId/eventKey, minimal resource/recipient/member identifiers, pending status, availableAt and attemptCount=0. Event keys/types are stable server labels, never contact data or tokens. Internal lifecycle storage supports pending/processing/delivered/failed plus lease fields; claim/retry/delivery workers remain Phase 11. No email is sent here. Services must verify resource/recipient tenant ownership before appending; an ObjectId alone cannot prove it. Provider retries, scheduling, lease durations and retention are not silently selected.

## Durable idempotency — Task 2.5

executeIdempotent requires a connection, explicit tenant/global scope, actorId, operation, a printable 8–200 character key, validated request DTO, caller-supplied positive retentionMs, an authorization callback and transactional work callback. No production retention default is configured: D08 remains PENDING APPROVAL. Tests use a 60-second fixture value only. Keys and canonical request JSON are SHA-256 hashed; raw keys/bodies are not persisted. JSON canonicalization sorts object keys and bounds depth/encoded size, rejecting non-JSON values, cycles and operator/prototype keys. Services must first normalize and validate domain DTOs.

The unique index is (scopeKey,actorId,operation,keyHash). scopeKey is non-null global or tenant:<canonical organizationId>. This explicitly separates global and tenant requests without relying on null organizationId and gives the tenant uniqueness specified in DATABASE_DESIGN.md. Different users, tenants and operations can safely reuse a key.

In one transaction the service reauthorizes, replays an unexpired matching result or reserves a pending record, executes work, then persists a completed status/result with effects. Changed request hashes conflict. Work must use the supplied session, remain sequential, and have no external effects. Work returns only status 200/201/202 and an explicitly projected safe JSON DTO. Stored success data/status are identical for first execution and replay; transport requestId metadata is generated by each future handler. Cookies, secrets, raw responses and full request bodies are never suitable stored results. Failed work leaves no reservation or effects. Expiry is checked in application logic, including records TTL has not yet removed; retention starts on completion. After expiry work may run again, so durable domain lifecycle checks remain mandatory.

Authorization is required before every execution/replay/recovery read. Critical module services must revalidate/touch the architecture's account/organization/membership/entitlement guards there. An empty authorization function is only suitable for disposable probe tests, never for an endpoint. A unique reservation race or unexpected transaction outcome triggers a separately reauthorized read-only lookup: if a completed matching result exists, return it; otherwise propagate the failure. There is no outer retry of effects. Driver commit handling resolves UnknownTransactionCommitResult where possible. This cannot promise a result when database connectivity is unavailable; a later same-key request can resolve it. Never automatically retry with a fresh key.

## Explicit infrastructure deployment

scripts/db/validators.ts defines strict server validators for auditEvents, outboxEvents and idempotencyRecords. It enforces BSON types, allowed fields, required timestamps, actor/scope alternatives, tenant/scopeKey consistency, bounded payloads, result presence and nonnegative integral attempt counts. scripts/db/indexes.ts deploys six named indexes, verifies keys/unique/TTL/options and rejects validator drift or unapproved audit/outbox TTL. Models do not synchronize indexes or validators at application startup.

Commands from the project root:

```powershell
npm run db:plan
npm run db:verify -- --database libraryos_dev
npm run db:apply -- --database libraryos_dev
```

Plan prints only collection/index scope and opens no connection. Apply/verify load ignored .env.local and require --database to exactly match MONGODB_DB_NAME. The react-server condition only permits the server-only configuration module in this explicit Node script; Next.js client boundaries are unchanged. Apply modifies only these three collections, adding validators and indexes; it never drops collections/data/indexes. Existing invalid records stop deployment for an explicit migration. Conflicting indexes fail rather than being replaced automatically. Operations are not one transaction: inspect/fix a failed migration and rerun to converge. Verify is read-only. Apply requires a migration identity permitted to create indexes and modify collection validators; keep it separate from least-privilege application credentials rather than granting the app administrative access. Use deployment secrets rather than local files in hosted environments.

This implementation was applied only to owned disposable test databases, never Atlas. Review the plan and backup/migration procedure before applying to an environment with data. A successful apply/check is a prerequisite before enabling future mutation APIs; the idempotency uniqueness guarantee depends on its deployed unique index. There are no mutation routes yet. Deployment/provider/retention choices and recovery objectives remain PENDING APPROVAL D08/D09.

## Global identity foundation — Task 3.1a

src/modules/auth/user-model.ts defines User as a global identity. It contains normalizedEmail, passwordHash (excluded from normal queries), optional verifiedAt, required explicit status and nonnegative safe-integer sessionVersion/authorizationVersion/operationFence counters. User has no organizationId, role, branch assignments or patron identity fields. Strict writes reject unknown fields. No status or activation default is set: D02 is PENDING APPROVAL, and a stored status does not itself authorize anything. Probe tests use fixture_only solely as a test value, not an approved account lifecycle state.

normalizeEmail performs basic bounded syntax checks, trims outer whitespace and lowercases; it preserves dots and plus suffixes without provider-specific rewriting. This does not verify ownership or deliverability. Services must normalize before persistence; the model rejects noncanonical values. The explicit users validator enforces required fields, canonical trim/lowercase storage, strict allowed fields and numeric guards, while a unique normalizedEmail index arbitrates concurrent inserts. No account linking occurs by matching email.

scripts/db/identity.ts exposes deployUserIdentity for explicit provisioning and verification, exercised only on disposable test databases in this task. It refuses existing invalid data, applies strict validation and creates user_email_unique without deleting data/indexes. The Phase 2 deployment CLI still targets only its original three collections; no users collection was created in Atlas. Identity CLI integration should follow the completed hashing/schema review rather than silently expanding the existing Phase 2 command.

Task 3.1b now supplies password hashing/verification and a shared format contract enforced by the User model and database validator. Tests use real hashes of synthetic passwords; there is no authentication endpoint or login path. Do not use this model directly as a registration handler. Future creation services must supply approved account states and hash credentials through the password service, explicitly project safe account DTOs, and never serialize create() results (select:false protects queries, not already-loaded documents). Authentication services may explicitly select +passwordHash solely for verification and must not return/log it.

## Argon2id password storage — Task 3.1b

src/modules/auth/passwords.ts provides hashPassword and verifyPassword using pinned argon2 0.45.1. Technical settings are Argon2id v19, 65,536 KiB (64 MiB) memory, 3 iterations, parallelism 1, a fresh library-generated 16-byte cryptographic salt and 32-byte output. Settings exceed the published [OWASP minimum](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html) of 19 MiB/2 iterations/parallelism 1; [node-argon2 documentation](https://github.com/ranisalt/node-argon2) describes the hash/verify API. Package-specific behavior was checked against the installed source, including random salts and PHC serialization with m,p,t ordering. No handwritten cryptographic comparison is used.

Passwords are neither trimmed nor Unicode-normalized nor truncated. Empty/ill-formed Unicode input and input above a 4096-byte infrastructure bound are rejected without echoing values. This technical bound is not an approved public password policy: minimum strength/length, final user-facing maximum and breached-password checks remain PENDING APPROVAL D02. No endpoint is enabled. Future registration/reset validation must apply approved policy before hashing; future login must preserve exact input and perform equivalent dummy verification for nonexistent accounts plus distributed rate limiting to address enumeration/resource abuse. The primitive alone does not solve those endpoint threats.

The shared password-format.ts contract accepts only canonical Argon2id v19 hashes with a 16-byte salt, 32-byte digest and bounded explicit verification profiles: memory 19,456/32,768/65,536/131,072 KiB, iterations 2–6, parallelism 1–4. Unsupported/malformed/oversized hashes fail verification before native work, preventing stored parameters from requesting unbounded memory/CPU. These compatibility bounds are technical safeguards, not acceptance of arbitrary legacy algorithms. User model and database validator reject plaintext/unsupported hash formats; a syntactically valid hash is still never accepted directly from a client. A database cannot prove the provenance of a well-formed digest.

Verification returns verified plus needsRehash, with the latter true only after a successful match whose encoded parameters differ from the current profile. It does not persist changes. A future service must review rehash policy (including avoiding accidental weakening of stronger existing profiles), guard concurrent credential changes and never rehash an incorrect password. Unexpected native failures become sanitized SERVICE_UNAVAILABLE without original causes, messages, passwords or hashes. No peppers/secrets are invented or stored; no authentication roles or session defaults were added.

### Reproducible local benchmark

Run npm run benchmark:passwords. The script generates synthetic random input internally, warms up once, measures five sequential hash/verify samples and one pair of concurrent hashes, and prints only settings/hardware/timings/process memory. It loads no environment file or database and prints no hashes/passwords. The server-only condition supports this explicit Node benchmark without weakening Next.js client import protection.

Recorded October 19, 2026: Node 24.18.0, Windows x64, Intel Core i5-10210U, 8 logical CPUs, 16,157 MiB total system memory, profile above:

| Measurement | Result |
| --- | --- |
| Hash median / maximum (5 samples) | 161 / 165 ms |
| Verify median / maximum (5 samples) | 161 / 163 ms |
| Two concurrent hashes, elapsed | 168 ms |
| Peak whole-process RSS | 192,852 KiB |

This is a small local sample, not a p95/SLA, isolated KDF memory measurement or deployment capacity test. Repeat on selected deployment hardware with realistic concurrent auth load before release. Bound concurrent expensive requests with the future distributed limiter/admission layer; a per-hash memory limit alone does not bound aggregate load. Deployment benchmark and hosting selection remain PENDING APPROVAL D09/release gates.

The package supplies a working Windows x64 prebuilt native binary, exercised by real tests and the standalone benchmark. npm reported pending install-script reviews for argon2 and the pre-existing unrs-resolver; no blanket script approval was applied. No source-build toolchain was needed for this local installation. Verify binary availability and installation policy on each deployment platform. Runtime-only npm audit reports zero findings at this checkpoint; the five existing development lint-chain findings remain documented. Identity deployment has not run against Atlas; existing synthetic/nonconforming user records require an explicit migration rather than loosening validators.

## Session storage and cookie primitives — Task 3.2a

src/modules/auth/session-model.ts defines a global Session with tokenHash, userId, explicit expiresAt, optional revokedAt and nonnegative integral sessionVersion. It stores no tenant, role or branch authorization. Strict schema/server validators reject raw token fields and unknown authority fields. tokenHash is excluded from default model queries; lookup predicates can still use it. create() results or explicit selections remain private server data and must never be returned as account DTOs.

createSessionCredential() in sessions.ts generates a fresh 32-byte cryptographic random token encoded as canonical unpadded base64url, plus its SHA-256 digest. Return the raw token only through the protected cookie; persist only tokenHash via an explicit projection. Never persist/log the returned credential object. hashSessionToken rejects noncanonical input before returning the digest. Token hashes are not password hashes: random 256-bit tokens do not need the password KDF.

sessionCookie requires a caller-supplied valid future expiry and returns options for __Host-libraryos_session with Secure, HttpOnly, SameSite=Lax, Path=/, no Domain and no lifetime default. Apply through the future Route Handler cookie API; no cookie is currently set by a route. Use secure local development transport when integrating browser authentication rather than weakening these options. clearedSessionCookie expires that same cookie with Max-Age=0; clearing it alone does not revoke a server session. Future logout must revoke server-side first.

scripts/db/sessions.ts explicitly provisions/verifies strict session validation, unique tokenHash, userId lookup and expiresAt TTL(0). It refuses existing nonconforming data; neither startup hooks nor the Phase 2 CLI apply it automatically. This helper has run only on disposable test fixtures, never Atlas. TTL is asynchronous cleanup, not authentication: the later resolver must independently require unexpired/unrevoked sessions, a current permitted user status and matching sessionVersion on every protected request. User foreign-key existence is a service responsibility, not guaranteed by MongoDB or this storage slice.

No request is authenticated and no session is issued merely by creating a credential or model record. Task 3.2b added trusted user checks/rotation/revocation; Task 3.3a now enforces the approved lifecycle policy below. Auth limiter choices were approved in 3.2d. APIs remain disabled until reviewed orchestration/configuration/browser integration. Short test expiry inputs are fixture values, not product defaults.

## Session validation, rotation and revocation — Task 3.2b

createSessionService(connection, policy) in src/modules/auth/session-service.ts requires an explicit nonempty allowedUserStatuses list and requireVerifiedEmail boolean. It copies these inputs and selects no activation policy or lifetime. Fixture states in tests are not production states. D02 account activation, idle/absolute lifetime and concurrent-session limits remain PENDING APPROVAL; no public authentication flow is enabled until the policy is approved and integrated.

resolve(token) hashes canonical input, requires a database session with expiresAt strictly after now and no revokedAt, then checks the current global User, allowed status, required verification and matching sessionVersion. It rechecks expiry after reads and returns only immutable userId/sessionId/version fields. Unknown, malformed, expired, revoked, missing-user or disallowed sessions resolve to null. Database errors become sanitized SERVICE_UNAVAILABLE rather than silently authenticating or treating an outage as an anonymous session. There is no authoritative membership/role cache and no password/token/hash returned. No cross-request caching is implemented.

issue(context, identity, expiresAt) is an internal primitive only for a future service that has just verified credentials. The userId/sessionVersion/authorizationVersion must come from that verified server-side user read, never a request, cookie or arbitrary principal. It touches the user's operationFence with status/verification/expected-version predicates, then inserts only a hashed credential and explicit expiry. Caller-provided identity values are copied before asynchronous writes. The helper does not verify a password itself and must never be called as a raw API handler.

rotate(context, token, expiresAt) checks the old session/current user inside the supplied transaction, touches the same user guard, conditionally revokes the old token and inserts a fresh token. Concurrent rotations compete on the same user/session records, so only one commits. Both revocation and replacement roll back together. Return/set the raw replacement token only after the outer transaction commits. A lost final commit acknowledgment may require fresh login because raw replacement tokens are deliberately not stored for recovery; do not introduce an outer retry loop or assume a failure means rollback.

revoke(context, token) now revokes the browser family, including rotated credentials, under the approved Task 3.3a policy below. Malformed/unknown tokens are harmless. It touches the same user guard as rotation, so either commit order leaves that family's replacement invalid. Clear the protected cookie only after successful server-side revocation; cookie clearing alone is insufficient.

revokeAll(context, identity) requires the current approved user state/versions, increments sessionVersion and operationFence, then marks that user's sessions revoked in the same transaction. It invalidates stale credential-verification reads: concurrent issuance either commits before revoke-all and is invalidated, or retries against the new version and fails. Account suspension, password changes and future sensitive operations must use the same user record/guard protocol. Dedicated account-recovery rules for suspended/unverified users remain later approved flows, not an implicit bypass in this self-service primitive.

All lifecycle writes require the caller's active transaction; use runTransaction or the same context as password/audit work. Resolution also performs conditional lastSeenAt bookkeeping. Apply required audit events in the outer mutation service transaction. Ordinary resolution is not a write lock across the protected action: critical domain mutations must transactionally revalidate session/account/tenant guards. CSRF, limiter and lifecycle primitives are now implemented; endpoint wiring and trusted deployment configuration remain prerequisites for enabling auth flows.

## Session-bound CSRF and trusted Origin — Task 3.2c

createCsrfProtection in src/server/security/csrf.ts requires a canonical HTTPS public origin and an injected secret of at least 32 cryptographically random bytes. Provision a distinct persistent server secret shared across replicas; no environment default or per-process generated key is supplied. Configuration is copied. Trust never comes from request Host, Forwarded, X-Forwarded-Host or Referer. The configured Origin must be exact (scheme, hostname and port), without paths/trailing slash/credentials. Local browser auth integration must use HTTPS consistently with Secure session cookies.

issue(principal) generates a 256-bit random nonce and an HMAC-SHA256 signature bound to domain/version, configured origin, user ID, session ID, sessionVersion, authorizationVersion and nonce. Tokens contain no raw cookie credential or encoded account identifiers. They use a strict bounded canonical format and constant-time MAC comparison. No separate CSRF cookie/database field is needed: the session-bound signed token is returned through a same-origin response and supplied in X-CSRF-Token. This mechanism follows [OWASP's session-bound HMAC/custom-header guidance](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html).

For each cookie-authenticated mutation, first resolve the session afresh through createSessionService.resolve, then call assertMutation with that principal before domain work. The guard requires POST/PUT/PATCH/DELETE, exact Origin, application/json content type and the valid X-CSRF-Token header. Missing/null/foreign/duplicate/lookalike origins and missing/duplicate/tampered tokens fail closed with generic errors. Cookie-only and HTML form submissions are rejected. Unsupported methods produce BAD_REQUEST rather than silently bypassing the mutation guard. GET/HEAD/OPTIONS handlers must remain free of domain mutations and do not call this mutation-only helper.

A principal argument is not authentication proof by itself: it must be the fresh trusted resolver result, never a body, URL, cached browser value or fabricated object. Revocation/expiry must still be checked by the session service. Rotation or changed user/session/authorization versions require a newly issued CSRF token. Tokens can be reused during the same valid session/version; this is CSRF protection, not one-time operation idempotency. Domain idempotency and transactional permission guards remain necessary. Rotating the signing secret invalidates existing CSRF tokens; clients need a same-origin refresh flow, not weaker validation.

Future token delivery must use same-origin authenticated no-store responses or safe server rendering; never place tokens in URLs, logs or permissive cross-origin responses. SameSite cookies and CORS configuration remain complementary browser controls, not substitutes for the guard. No token delivery endpoint, CORS relaxation or cookie changes are implemented here. The eventual unauthenticated login/bootstrap flow needs its own reviewed pre-authentication CSRF/Origin protection in Task 3.3: a null principal is always rejected by this authenticated guard and must never be replaced with a fake logged-in principal. Current auth endpoints remain disabled. D09 public origin/key provisioning and limiter policy remain PENDING APPROVAL.

## Approved MongoDB authentication limiter — Task 3.2d

The user explicitly approved this scoped D09 decision on October 19, 2026: MongoDB shared storage using the existing Atlas deployment, fail closed with 503 when unavailable, and the following initial limits. No Redis/provider or paid infrastructure was added.

| Operation / subject | Approved limit | Counting |
| --- | --- | --- |
| Login / normalized account email | 5 / 15 minutes | Failed attempts plus currently reserved verifications; success refunds its own reservation once |
| Login / trusted IP | 30 / 15 minutes | All admitted attempts, including attempts later rejected by the account limit |
| Registration / trusted IP | 5 / hour | Requests |
| Registration / normalized account email | 3 / hour | Requests |
| Recovery / trusted IP | 5 / hour | Requests |
| Recovery / normalized account email | 3 / hour | Requests |

src/server/security/rate-limit.ts exposes async createMongoRateLimiter(connection, secret), beginLogin(email, trustedIp) and checkRequest(registration|recovery, email, trustedIp). Thresholds are explicit immutable values in rate-limit-contract.ts, which also supplies strict shared storage specifications and readiness verification. Inputs must already satisfy endpoint validation; bad trusted-IP/internal inputs fail closed rather than silently skipping limits. The limiter performs no user existence lookup and uses identical accounting for unknown addresses.

Use a dedicated random server HMAC key of at least 32 bytes, persistent/shared across replicas. The factory copies the key; tests use deterministic fixture bytes only. Subject keys are domain-separated HMAC-SHA256 digests of operation plus normalized email/IP; raw addresses are not stored or logged. IP parsing rejects lists, hostnames and zone identifiers and canonicalizes equivalent IPv6/IPv4-mapped forms. trustedIp must come from the deployment's reviewed trusted ingress adapter, never arbitrary X-Forwarded-For, request bodies or client-controlled headers. Hosting/proxy trust extraction remains PENDING APPROVAL D09; no ingress is assumed here. Secret rotation changes bucket identities and resets effective limits, so treat it as an operational migration rather than a per-process startup action.

The algorithm is a bounded fixed window anchored to the first request/reset for each operation/subject. MongoDB $$NOW defines times and resets, avoiding application-clock disagreements. Windows can admit bursts on either side of a boundary; these starting limits are not a sliding-window/WAF or DDoS guarantee. Atomic updates admit only while count < limit and never increment denied requests above the cap. Expiry is evaluated during operations; TTL is asynchronous cleanup only. Store queries outside a transaction use a 5-second driver execution budget; transactions use the existing bounded 15-second retry budget. These are technical bounds, not API latency promises.

beginLogin first charges the IP bucket, then atomically reserves one account slot and a pending attempt record in a transaction. Up to five verifications can be pending/failed for the account window, preventing simultaneous password guesses from bypassing the failed-attempt limit. It returns only a server-side permit with complete(success|failure). After actual trusted credential/account-state verification, complete(success) releases exactly that attempt's account slot once; complete(failure) retains it. IP usage is never refunded. Repeated/conflicting completion cannot undo the first outcome or refund twice. A crash/lost acknowledgment conservatively retains an unfinished slot until window expiry. Late completion matches windowId and cannot reduce a newer window's count. Outcomes must never come from a client field.

Registration/recovery charge IP then account sequentially. An account denial still consumes the admitted IP request; callers must not retry with new identifiers to bypass a denial. A real cap returns the existing RateLimitError/429 with positive Retry-After seconds; storage/configuration failures become generic SERVICE_UNAVAILABLE/503 without raw causes. No in-memory fallback or fail-open mode exists.

scripts/db/rate-limit.ts exports deployRateLimitStorage for explicit migration orchestration. It creates/verifies rateLimitBuckets and loginRateLimitAttempts with strict validators, primary-key uniqueness and TTL(expiresAt,0), refusing nonconforming existing data. It never drops data/indexes. The service factory verifies validators/index readiness and fails closed if missing. The Phase 2 db:apply command remains scoped to its original collections; auth schema deployment must explicitly compose identity, session and limiter deployment helpers before routes are enabled. Only disposable tests were provisioned in this task, never Atlas. Use a separate migration identity where needed; do not broaden the application's privileges.

Future login integration must validate bounded request input, acquire a permit before the expensive KDF, perform real or equivalent dummy credential verification, record the trusted result, and only issue an authorized session/cookie after required checks succeed. Any unresolved store failure must stop the request. Domain/audit transactions and CSRF remain separate required controls. Registration/recovery endpoints are still disabled until their own approval/review. Limits for verification tokens, invitations, reports, search, uploads and other costly operations remain PENDING APPROVAL; these auth thresholds are not silently reused for them.

## Approved browser-session policy — Task 3.3a

The user approved active+verified-only login, an 8-hour absolute lifetime, 30-minute idle timeout, at most 3 concurrent browser sessions (new login evicts the oldest), logout of the current browser including rotations, and revocation of all sessions after successful password reset. Public registration remains disabled until its later review. session-policy.ts records these explicit choices. Future production services must pass APPROVED_SESSION_POLICY; alternate status policies in isolated tests are fixture-only.

Sessions now require familyId, startedAt and lastSeenAt. issue creates a new browser family, clamps the supplied deadline to startedAt + 8 hours and, under the user guard, revokes oldest still-valid families to keep the cap at three. It counts current-version, unrevoked, unexpired and non-idle sessions; stale timed-out records do not consume slots. Oldest means original family start, with familyId as a deterministic tie-breaker. Concurrent issuance and eviction serialize on the user record and roll back together if the surrounding login transaction fails.

resolve requires non-idle lastSeenAt and performs a conditional monotonic activity update only while the token remains valid, after the fresh user check. Authenticated request activity refreshes idle time; background polling therefore counts as activity, but cannot extend the absolute deadline. Expired/idle sessions are never resurrected. Hosts must use synchronized clocks for these application-time session checks; limiter timing separately uses MongoDB time. Rotation preserves familyId, original startedAt and the previous absolute deadline (or a shorter explicit deadline), so repeated rotations never renew the 8-hour budget. Existing token records remain until absolute-expiry TTL cleanup, allowing a rotated token to identify its browser family for revocation.

revoke finds the family even from an already-rotated token, touches the user guard without requiring an active account (logout must work for suspended accounts), and revokes all still-live tokens in that family. This serializes against rotation in either order. Other browsers are unaffected. A missing/deleted user cannot authenticate and its orphan family can still be revoked. revokeAll retains its atomic sessionVersion invalidation of every browser; the future reset service must invoke equivalent guarded invalidation in the reset transaction rather than merely clearing cookies.

The explicit sessions validator now requires family/activity metadata and rejects deadlines beyond the 8-hour bound; a user/family index supports revocation. Prior schemas/records require reviewed migration or deliberate session invalidation before deployment: deploySessions refuses nonconforming records rather than fabricating family history. No Atlas migration has been run. Cookie security and CSRF/session-ID binding remain unchanged. Ordinary lookups are not a replacement for transactional authorization guards on sensitive actions.

## Credential/session/audit orchestration — Task 3.3b

createAuthService in src/modules/auth/service.ts combines the approved MongoDB limiter and session policy with password verification and mandatory global audit events. Cache its initialization promise per server process/connection; it generates one strong random dummy hash on initialization rather than per request. validateLoginInput accepts exactly email/password, normalizes only email, preserves password bytes, rejects unknown privilege fields and applies the existing infrastructure input bound. The shared password byte constant was moved to password-format.ts so basic email validation does not import the native hasher unnecessarily.

login(body, trustedIp, requestContext) acquires a shared permit before password verification or user-sensitive work. Unknown users and malformed stored hashes use a current-profile dummy digest for native verification. Wrong credentials, non-active status and unverified email all produce the same generic UNAUTHENTICATED failure and retain the account failure reservation. A successful approved credential decision refunds the account reservation (never the IP charge); a later infrastructure failure is not misclassified as a bad password. Stored compatible hashes can have different bounded work factors, so this primitive is not a universal timing-equality guarantee across legacy profiles. Automatic rehashing remains deferred rather than silently weakening a stronger profile.

Before issuance the transaction rechecks the exact verified password hash and user/session/authorization versions, then uses the shared user guard to serialize credential/state changes and browser-cap eviction. It commits the new session and auth.login audit together. Audit records identify a sessionFamily and contain only safe labels/IDs; no email/IP/password/token/hash values are included. If audit fails, issuance/eviction/user-fence changes roll back. The result contains private cookie transport data plus an explicit user DTO; the future handler must set the HttpOnly cookie and return only user, never serialize the whole service result. Current service result includes no tenant permissions.

logout(token, requestContext) is an internal browser-family revocation use case, not an HTTP permission boundary. Future handlers must apply the reviewed Origin/CSRF protocol before calling it. It can identify a family through a rotated credential, revokes under the shared user guard, and appends auth.logout in the same transaction. Repeated/missing-token logout is idempotent and does not duplicate successful audit records. Audit failure rolls back revocation; clear cookies only after the service succeeds. Suspended accounts can still revoke their own family via a suitably protected handler. Password reset orchestration remains Phase 3.4 and must atomically invalidate all sessions.

The user selected local HTTPS on loopback as the first API target. That upcoming runtime will use a fixed loopback IP limiter identity and ignore all forwarded-IP headers. Hosted ingress is not approved or inferred from that choice. No API or local certificate/environment change is included in this service-only checkpoint; Atlas remains untouched.

## Pre-authentication and logout challenge — Task 3.3c.1

src/server/security/auth-csrf.ts provides a separate five-minute authentication protocol challenge, not a fake authenticated principal. A random 256-bit nonce is placed in __Host-libraryos_auth_challenge with Secure/HttpOnly/SameSite=Strict/Path=/ and no Domain. A same-origin response can expose only the signed token, never the nonce cookie value. The HMAC transcript includes protocol domain/version, trusted Origin, login/logout purpose, nonce and expiry; logout additionally binds the current authentication cookie digest. This allows an inactive account to safely revoke its own browser family without granting it authenticated access or weakening the existing protected-mutation guard.

POST validation requires exact Origin, JSON, the custom CSRF header and canonical nonce/signature. Missing/different cookies, cross-purpose tokens, another session cookie, expired/future-dated tokens and tampering fail closed. Cookies are cleared after successful login/logout to end the pre-session; failures can reuse a still-valid challenge. These are protocol primitives only: the eventual bootstrap handler must return no-store same-origin JSON, reject cross-site bootstrap requests, and set/clear cookies through server APIs. The five-minute nonce budget is a technical pre-session bound, independent of the approved 8-hour/30-minute authenticated session policy. CSRF tokens are not business idempotency keys.

## Local HTTPS configuration and launcher — Task 3.3c.2

The first approved auth runtime is local development on 127.0.0.1 only. Run npm run auth:local:setup, then npm run dev:https. Setup creates a 30-day self-signed certificate/key under ignored .local/https and a separate ignored .env.auth.local containing AUTH_ORIGIN=https://127.0.0.1:3000 and two independent random 32-byte hex signing keys. Existing certificate/settings files are preserved and the certificate/key/hostname/expiry are checked. OpenSSL is required; on this Windows machine the bundled Git executable is used. Setup does not load or change .env.local/MongoDB settings. Browser certificate acceptance is local development only; no OS trust-store installation is performed.

The launcher loads .env.auth.local only if an explicit AUTH_ORIGIN was not already supplied, validates configuration and starts Next's HTTPS dev server with the explicit certificate and --hostname 127.0.0.1. It uses the configured port exactly and sets a private launcher marker. Certificate files are required before start; there is no fallback certificate downloader or automatic machine trust change. readLocalAuthConfiguration requires development mode, this marker, canonical https://127.0.0.1 origin and distinct valid private keys. HTTP/hosted/production configurations fail closed; host/proxy headers are not a source of trust. The eventual API adapter will use a fixed loopback limiter identity, ignoring forwarded-IP values. Hosted deployment needs its own reviewed ingress/configuration path.

Private files must remain ignored. The setup preserves keys on repeat runs so restarts do not silently invalidate challenge/limiter identities. When the certificate expires, explicitly replace its ignored certificate/key pair and rerun setup; changing signing keys resets their associated security state and needs deliberate handling. This is local setup infrastructure, not production TLS or release readiness. No real database connection is made merely by starting the public shell.
