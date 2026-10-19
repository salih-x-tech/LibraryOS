# Permissions and authorization

Status: design for approval. Sources: [SRS.md](SRS.md), [ARCHITECTURE.md](ARCHITECTURE.md). Decision IDs below refer to the architecture decision register.

## Four distinct identities and scopes

`User` is a global login identity with no implicit tenant privileges. `OrganizationMembership` associates that user with one organization and a fixed role. `BranchAssignment` associates a staff membership with an authorized branch; it is neither a role nor a patron record. `LibraryMember` is the organization-owned borrowing record and may exist without a login. Self-service requires an approved verified User link and active organization membership. Platform assignments are separate from tenant memberships.

Effective access requires an active user/session, active membership, allowed capability, authorized branch or patron ownership, permitted organization state and relevant plan entitlement. An entitlement never grants a permission. Unknown capabilities and unresolved permissions are denied.

## Proposed capability matrix

O=Owner, A=Admin, L=Librarian, M=Member. The following defaults and customization ceilings are **PENDING APPROVAL** D03; they are proposals, not additional approved requirements. Staff branch actions require branch assignments unless explicit organization-wide scope is approved. Owner status alone must not create an undocumented branch bypass.

| Module | Proposed capabilities/default roles | Scope and boundary |
| --- | --- | --- |
| Authentication/users | account.readSelf/updateSelf: all authenticated users | Own global account only; no tenant-global email directory |
| Organizations | organization.read: O/A/L; organization.update: O/A | Current organization; M receives minimal workspace context |
| Branches | branch.read: O/A/L; branch.manage: O/A | Assigned branch for operations; explicit organization administration for creation |
| Staff | staff.read/invite/manage: O/A; permissions.configure: O | Same organization; delegation ceiling and protected actions checked |
| Members | member.read/create/update: O/A/L; member.readSelf: M | Authorized home branch under approved member scope; M owns linked record |
| Catalog | catalog.read: O/A/L/M; catalog.manage: O/A/L | Organization catalog; branch availability remains filtered |
| Inventory | copy.read/manage, inventory.adjust: O/A/L | Copy branch; transfer requires source and destination authority |
| Circulation | circulation.issue/return, loan.read: O/A/L; loan.readSelf: M | Operational branch for staff; own history for M; physical actions staff-only |
| Reservations | reservation.manage: O/A/L; reservation.createSelf/readSelf/cancelSelf: M | Approved queue/pickup scope and patron ownership |
| Renewals | renewal.decide: O/A/L; renewal.requestSelf: M | Loan branch or own active loan |
| Policies/fines | policy.read: O/A/L; policy.manage: O/A; fine.read: O/A/L; fine.adjust: O/A; fine.readSelf: M | Policy scope or fine's loan/member scope |
| Dashboard/reports | report.read: O/A/L; dashboard.self: M | Authorized branches; member dashboard only own records |
| Notifications | notification.readSelf/markSelf: recipient; notification.configure: O/A | Organization plus recipient; no other inbox access |
| Subscription | subscription.read/manage: O; usage.read: O/A | Whole organization; no branch-local quota |
| Audit | audit.read: O/A | Organization and authorized resource scope; no edit/delete API |
| Platform | platform.organizationManage: Super Admin; support metadata: Platform Support | Separate platform authorization; tenant-content access denied pending D07 |

Member scope for staff when a patron has no home branch, organization-wide borrowing, combined staff/patron access and final default grants are **PENDING APPROVAL** D03–D04. Do not equate patron home branch with staff branch assignment.

## Customization and protected actions

Roles remain fixed: Owner, Admin, Librarian, Member. Owners customize staff capabilities through a validated allowlist within approved per-role ceilings. Explicit deny wins. A grantor cannot assign foreign branches or grant beyond their delegation ceiling. No arbitrary permission JSON or custom roles. Admin cannot grant Owner status or escalate themselves.

Proposed Owner-protected operations: ownership transfer, Owner assignment/removal, capability ceiling changes, subscription changes and approval of organization deletion/export. Exact list, multiple-Owner policy and transfer flow are **PENDING APPROVAL** D03/D08. Prevent removal of the last active Owner through the organization transaction guard. Permission, membership and branch-assignment changes increment authorization versions and touch the guards used by critical transactions.

## Enforcement sequence

1. Resolve session and current user status; reject expiry/revocation.
2. Resolve organization and active membership server-side. URL/body organization identifiers are untrusted selection inputs.
3. Check capability, bounded customization, organization state and feature entitlement.
4. Load resources with organization predicates and verify all reference ownership.
5. Check branch assignment or linked-patron ownership. Reject unauthorized branch filters rather than broadening them.
6. For critical mutations, revalidate transactional authorization guards before committing.
7. Return an allowlisted DTO and append required audit events.

Use 404 for foreign/invisible resources and 403 for known operations lacking capability. Server Components, Route Handlers, exports and jobs use the same service rules; middleware and hidden buttons are insufficient. Never retain authoritative tenant permissions indefinitely in a session cookie.

## Reports, workers and platform access

Aggregations begin with organization and permitted branch filters; joins match organization too. Members see only their own circulation/fines. Catalog visibility does not imply visibility of all branch holdings or patron data. Personalized caches include tenant and authorization scope, or are disabled.

Jobs have scoped system identities and fixed capabilities; payload resources must match their organization. Platform users are not automatically tenant Owners. Until support policy D07 is approved, deny tenant-content inspection and impersonation. Future support access needs approved scope, expiry, reason, consent rules and audit.

## Verification

Test every capability with allowed/denied roles, explicit override denies, inactive membership, suspended organization, foreign tenant, unauthorized branch and wrong patron ownership. Include multi-organization users with different roles, stale-session revocation, forged assignment IDs, report leakage, invitation escalation and simultaneous last-Owner removal.
