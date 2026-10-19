# LibraryOS — Phase 1 Requirements Baseline

**Version:** 1.0 (architecture and MVP baseline)  
**Status:** Phase 1 decisions approved; operational defaults pending validation  
**Release strategy:** Controlled pilot with real libraries before public launch

## 1. Product Overview
LibraryOS is a cloud-based, multi-tenant library management SaaS for school, university/college, public, and private/commercial libraries. One organization owns a workspace, can operate multiple library branches, and has one subscription relationship. Organizations' records must remain isolated.

## 2. Users, Roles and Permissions
Platform roles: Super Admin, Platform Support. Organization/library roles: Owner, Admin, Librarian, Member. Roles are fixed; organization Owners may customize staff capabilities within secure limits, but cannot delegate protected Owner privileges. Users may belong to multiple organizations with different roles. Access control must be enforced server-side and, where applicable, branch-by-branch.

## 3. Tenant and Branch Model
- The organization/workspace is the security and subscription boundary (`organizationId`).
- Branches belong to one organization (`branchId`); copies and circulation operations are branch-scoped.
- Staff may have permissions at one or more branches.
- Catalog entries are organization-wide; physical inventory belongs to branches.
- Workspace creation and Owner membership assignment must be atomic.
- Workspace slugs are validated and unique; suspension restricts operations without automatically deleting records.
- Reports, asynchronous jobs, and aggregations must enforce tenant isolation.

## 4. Catalog and Inventory
- Support physical resources in MVP and extendable resource types for digital content later.
- Book catalog fields include title, optional ISBN, author(s), publisher, edition, publication year, category, language, description, cover, keywords.
- Physical BookCopy records reference a catalog item and organization/branch; each has a unique organization-scoped barcode, shelf location, acquisition date, condition and circulation status.
- A book may have multiple physical copies across branches; inventory totals are derived from copies.
- Authorized staff can manage catalog, copies, transfers and inventory adjustments, with audit history.
- Physical copy status and condition are separate. Unavailable copies cannot be issued.

## 5. Membership and Circulation
- Staff register/manage members; members may have contact details, category, home branch, membership status, validity and borrowing history.
- Librarians or authorized staff perform physical issue and return operations in MVP.
- Authenticated members can search, reserve titles, request eligible renewals and view their own borrowing history.
- Loans record member, copy, issue date, due date, branch and lifecycle. A copy cannot have two active loans.
- Use atomic issuance and return updates; enforce configured loan limits, renewal limits and reservation rules.
- Reservations use an ordered queue with pickup/expiry policy; fines are configurable and may be disabled.
- Default limits, fine amounts, and membership validity are **not finalized**.

## 6. Subscription and Billing
- Every organization has one current subscription relationship covering all branches.
- MVP starts on Free plan; feature and usage limits are enforced on backend across organization.
- Subscription/plan data structures must support future paid tiers, billing periods and provider integration.
- Automated payment collection is deferred; no raw payment card data is stored.
- Subscription changes must not automatically delete library data.
- Proposed Free plan thresholds (1 branch, 500 copies, 2 staff, 100 members) remain **unapproved**.

## 7. Dashboard, Reporting, Notifications and Auditing
- Role-specific dashboards show authorized organization and branch information.
- MVP reports: inventory summary, circulation, overdue, member activity, popular books; support date and authorized branch filters.
- MVP notifications: in-app and email for important circulation events and staff invitations.
- Notification delivery failures must not reverse successful circulation transactions; use retries and duplicate prevention.
- Audit sensitive administrative, permission, inventory and circulation changes with actor, action, resource, timestamp and tenant scope. Protect logs and avoid secrets.
- SMS, forecasting and advanced analytics are deferred.

## 8. Non-Functional Requirements
- Security: secure password hashing (e.g., Argon2id), HttpOnly session cookies, HTTPS, CSRF defenses, authorization on every protected operation, tenant and branch isolation, validation, safe upload handling, rate limiting and secrets management.
- Reliability: atomic critical transactions, concurrency-safe issue/return, automated backups and restoration tests, retry-safe background jobs, operational monitoring.
- Performance **provisional test targets**: p95 dashboard and circulation API <=2 s; book search API <=1 s; key page initial load target <=3 s under documented conditions.
- Availability **provisional objective**: 99.5% monthly uptime, subject to deployment definition and measurement.
- Usability: responsive desktop/tablet/mobile interface, accessible controls, WCAG 2.2 AA target.
- Visual design: Baroque-inspired forest green, antique gold, ivory; usability and contrast take precedence over ornament.

## 9. Proposed Implementation Stack
Next.js, TypeScript, Tailwind CSS, shadcn/ui, Motion, MongoDB Atlas, Mongoose, server-side sessions, Cloudinary, transactional email provider, Recharts, Vitest and Playwright. Backend organized as a modular monolith with domain services and API route handlers.

## 10. Pilot Release Plan
1. Complete architecture, domain model, authorization matrix and acceptance criteria.
2. Implement MVP modules in dependency order, with automated tests.
3. Prepare test/staging environment, backups, monitoring and onboarding documentation.
4. Onboard a small, consenting set of real library organizations with their own branches and staff.
5. Verify cross-tenant isolation, circulation correctness, permissions, notifications, data recovery, accessibility and user feedback.
6. Fix critical issues and conduct go/no-go review before wider public registration.

## 11. Unresolved Decisions Before Pilot
- Free plan limits and branch allowances.
- Circulation defaults: maximum loans, loan period, renewals, reservation pickup period, overdue fine settings.
- Member account activation and identity verification policy.
- Email provider, deliverability and notification consent policy.
- Audit log retention, personal data retention and deletion/export policy.
- Pilot library count, operational success metrics and go/no-go thresholds.
- Hosting, backup RPO/RTO and final service objectives.

## 12. Next Phase — System Design & Database Architecture
Proceed in small steps:
1. Confirm organization, branch and identity boundaries.
2. Define core entities and relationship cardinalities.
3. Define MongoDB collections, keys, indexes and constraints.
4. Define authorization and branch access rules.
5. Define circulation state machines and atomic operations.
6. Define module boundaries, APIs, events and background jobs.
7. Review threat model, test strategy and pilot acceptance criteria.

**First design decision to confirm:** Should an account have a single global identity (`User`) with separate organization-specific `Membership` records? **Recommendation: yes**; this enables one login to access multiple organizations safely.
