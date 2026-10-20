# Task 3.4b — activation and recovery policy proposal

Status: **APPROVED FOR SYNTHETIC IMPLEMENTATION** on October 20, 2026. The user selected the proposed password rules, account/token policy and synthetic test delivery boundary. Existing local HTTPS, session policy and disabled public registration remain in force. Real-user recovery endpoints remain disabled until a usable delivery adapter is separately reviewed. The descriptions below record the accepted choices; blocklist release evidence and hosted/real-delivery operations remain separate gates.

## Proposed scope and account eligibility

Implement verification only for existing accounts explicitly created in `pending_verification` status with no verifiedAt. Successful verification sets verifiedAt and changes that status to active. It creates no organization membership, patron association, role or browser session. Other states stay unchanged and denied. Public registration and account-creation tooling are outside this slice.

Offer password recovery only for existing active accounts with verified email. Recovery cannot reactivate suspended/deleted/pending accounts or establish email ownership. Unknown and ineligible addresses receive the same generic accepted response as eligible addresses. Infrastructure failures return the same sanitized failure regardless of account existence; failures must not be disguised as successful delivery.

After verification/reset, users sign in normally. Reset atomically consumes the token, verifies the current account/version under the shared user guard, changes the password, increments sessionVersion, revokes all browser sessions, invalidates every outstanding action token for the account and appends audit. No automatic sign-in. Verification similarly checks current state/version and commits its account/token/audit changes together. Failed transactions leave the token usable.

## Proposed token and abuse policy

| Choice | Proposed value |
| --- | --- |
| Verification token lifetime | 24 hours |
| Password-reset token lifetime | 30 minutes |
| Reissue | New issuance invalidates older outstanding tokens of the same purpose, serialized by the user guard |
| Token reuse/expiry/wrong purpose/version/state | Same generic invalid-or-expired result; no account-state disclosure |
| Request limits | Keep approved recovery limits: 5/IP/hour and 3/account/hour; verification requests share that budget to prevent doubling it |
| Completion limits | New independent shared buckets for verification and reset: each 30 attempts/IP/15 minutes; charge before token lookup or password hashing |
| Token delivery URL | Fixed configured HTTPS origin, token in URL fragment; read client-side, immediately remove with history.replaceState, then submit in same-origin JSON |
| Mutation protection | Extend signed challenges with separate verification-request, verify-email, reset-request and reset-password purposes; preserve exact Origin/JSON/custom-header checks |
| Responses and page handling | no-store; no-referrer on token pages; no third-party resources or analytics; never log tokens, passwords, email addresses or request bodies |

The exact lifetimes and completion limits above are proposed product/operational choices, not values prescribed by the references below. Failed attempts do not lock accounts or change account state. TTL remains cleanup; authorization checks enforce expiry independently.

## Proposed new-password rules

- Require 15–128 Unicode code points, within the existing 4096-byte infrastructure limit. Allow spaces, paste, password managers and Unicode; reject malformed Unicode. Do not truncate or silently trim passwords.
- Do not require a particular mixture of uppercase, lowercase, digits or symbols, and do not force periodic password changes.
- Reject whole-password matches against a maintained, locally configured common/compromised-password blocklist and obvious service/account-specific choices. No password or digest is submitted to a network service. Missing/invalid blocklist configuration fails closed when setting a password.
- Preserve the existing exact-byte hashing/verification convention; do not silently change normalization of existing credentials. This is a compatibility choice, not a claim of full NIST conformance.
- Apply these rules only when setting a new password; do not prevent existing otherwise-eligible accounts from logging in merely because an older password predates the new rules. Reuse of the current password is rejected on reset.

Blocklist provenance, coverage and refresh evidence must be reviewed before real-user recovery is released. A tiny test fixture list is sufficient only for deterministic isolated tests.

## Proposed first delivery boundary

For the next implementation slice, use an injected in-memory delivery sink owned by disposable integration/browser fixtures. It receives the raw link only after issuance commits, keeps it only for the test, and is never a production adapter. No real email, log delivery, raw-token files or public mailbox endpoint. Tests can simulate delivery failures without transmitting account data.

With this choice, build and test the complete guarded services and UI against synthetic accounts, but keep real-user verification/recovery routes disabled until a separately reviewed usable delivery adapter exists. Test-only delivery does not justify returning tokens in a public request response or claiming a real email was sent. If a usable developer inbox or actual email is required now, its access/retention/provider contract needs a separate decision before those routes are enabled.

## Acceptance evidence required after decisions

Test concurrent reissue and consumption; expiry and version mismatch; unknown/ineligible generic responses; shared throttling; stale reset versus password/state changes; all-session invalidation; rollback after audit failure; delivery-after-commit/failure behavior; no secret persistence/logging; token URL cleanup; keyboard/error/success behavior and accessibility. Use only owned disposable databases and synthetic accounts. Production/hosted ingress, MFA, patron claiming and deployment remain separate gates.

## Reference basis

[NIST SP 800-63B-4](https://pages.nist.gov/800-63-4/sp800-63b.html) describes password length, blocklist and password-manager requirements. [NIST implementation FAQs](https://pages.nist.gov/800-63-4-Implementation-Resources/faqs/) clarify the 15-character minimum for single-factor passwords. These inform the proposed password rules; this proposal does not certify compliance.

[OWASP Forgot Password Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Forgot_Password_Cheat_Sheet.html) supports generic responses, unpredictable single-use expiring tokens, normal login after reset and session invalidation. [OWASP Email Validation and Verification Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Email_Validation_and_Verification_Cheat_Sheet.html) supports purpose-specific verification handling and expiring single-use tokens. Exact account eligibility, delivery scope and expiry values remain LibraryOS decisions.
