# Recovery worker lifecycle and retention proposal

Status: **APPROVED FOR SYNTHETIC IMPLEMENTATION** on October 22, 2026. The user selected the proposed worker and retention policies. This record defines the scoped D08/D09 choices; it does not enable a live worker, email request endpoint, scheduling or external database cleanup. Implementation/acceptance evidence is recorded in IMPLEMENTATION_PLAN.md.

## Proposed processing contract

1. HTTP admission persists an encrypted intent and audit before returning generic request-received status. It does not check eligibility or connect to Gmail. An accepted request is not a delivery guarantee.
2. One worker atomically claims the oldest pending, non-expired intent with a random lease token and a two-minute lease. Database time controls the claim/expiry checks. Another worker cannot claim the same intent while leased.
3. The worker decrypts only in process memory and rechecks current account eligibility before token issuance. It does not charge the already-admitted request budget a second time. All authorization/version fences and token/account/audit rules stay in force. Token lifetime starts at actual issuance, not admission.
4. Before creating a token or starting delivery, the worker must still own a live lease. No SMTP send occurs inside a retriable database transaction. Token issuance is hash-only; raw credentials remain ephemeral and are never saved in the request queue.
5. Successful processing, including an unknown/ineligible account needing no email, ends in the same `completed` queue status. It is internal processing completion, not proof of inbox delivery. No account eligibility/result is exposed through an HTTP lookup.
6. Only the current live lease holder can finalize. Delayed/stale callbacks cannot rewrite a newer terminal result. Finalization and audit are atomic. This does not make SMTP and the database one atomic transaction: an email can be delivered before a crash or lost acknowledgment.

## Proposed failure/retry rule

No automatic resend or automatic requeue of a claimed intent. A failure after delivery may have begun, worker crash or expired processing lease becomes `uncertain` and requires operator review. A send timeout cannot prove that no email was sent. Known pre-send validation/decryption failures become `failed`; unprocessed intents older than 24 hours become `expired`. Raw provider exception text, addresses and tokens never enter queue result metadata or logs.

An expired lease does not prove an old process has stopped. A paused process could resume after a lease check; no design here promises exactly-once external delivery or that an already-started SMTP operation can be recalled. The absence of automatic reclaims prevents a second worker from blindly duplicating that operation. Uncertain jobs are never silently labeled delivered. Users may submit a fresh request under existing limits; normal reissue invalidates older outstanding action tokens.

The next implementation covers only worker primitives/lifecycle with synthetic tests. There will be no operator resend UI, automatic scheduler or public job-status endpoint. Operator replay would be a separate audited capability and must deliberately create a new request, not revive an old lease.

## Proposed retention rule

| Data | Proposed handling |
| --- | --- |
| Pending encrypted email | Keep for at most 24 hours after admission, then terminalize as expired |
| Processing encrypted email | Keep during the two-minute lease; expired claims terminalize as uncertain |
| Any terminal record | Immediately remove ciphertext, nonce and tag in the audited terminal transition |
| Terminal operational metadata | Keep for 7 days after terminalization, then delete only that terminal queue record |
| Audit records | Existing audit retention remains unchanged; never deleted by this worker |
| Action tokens/sessions | Existing explicit expiry/invalidation contracts remain unchanged |

Cleanup uses explicit lifecycle operations, not a TTL that could delete a live pending/processing request before auditing and removing sensitive payload. There is no global wipe, collection drop or deletion of users or library history. Cleanup is scoped to this queue and only terminal records beyond the agreed deadline. Backup retention/key recovery is not solved by deleting the live queue record and remains a deployment gate.

## Activation and acceptance boundary

These values are LibraryOS policy proposals, not defaults imposed by a provider or framework. The existing 30-minute reset and 24-hour verification token lifetimes are unaffected. A two-minute processing lease is longer than the current bounded Gmail operations but is not a delivery SLA.

After decisions, implement schema/readiness changes and lifecycle primitives against owned disposable MongoDB. Test competing claims, stale lease refusal, crash/expiry handling without replay, unknown/ineligible completion equivalence, audit rollback, terminal ciphertext erasure, scoped metadata cleanup and unchanged audit/user data. Keep actual email, HTTP activation, real database migration and scheduling disabled until the remaining credential/list/live acceptance gates are satisfied.
