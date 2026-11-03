# CRM, project billing, and invoices: architecture and delivery plan

Status: **initial deal/proposal/accepted-plan milestone implemented on a feature branch; remaining roadmap proposed**. Prepared 2026-11-03.

### Implementation decisions and current boundary

Confirmed during implementation kickoff:

- INR initially; India GST jurisdiction, with legal/tax details unconfigured and invoice issuance disabled.
- Bill monthly at month end; invoices are due 30 days after their issue date.
- A single platform administrator may assign/revoke SGS issuer authority with a mandatory audited reason. Actual customer workspace ownership is still required; authority assignment grants no financial read access by itself.
- Start GitHub with repository/board linking; App credentials and automation infrastructure will be configured later.
- Full roadmap remains the requested scope. This first milestone is not completion of invoices, resource/time tracking, payments, credits, change orders or GitHub integration.

Implemented: owner-only CRM navigation; standard list/detail/create/edit forms; fixed-price/hourly commercial terms; immutable published proposals; customer acceptance; SGS activation of one accepted base billing plan per project; durable financial events; indexed cursor lists; owner-invitation controls; finance-linked project retention; administrator issuer assignment.

Pending: billing schedules/resources/time statements and claims; invoice legal configuration/numbering/PDFs; payments/credits/refunds; GitHub linking and App/webhook/queue integration; deployment provisioning and production pilot. Defaults are commercial-plan metadata, not an active monthly invoice scheduler.

## 1. Executive decision

Extend the existing client hub with a small, project-centric CRM, not a separate CRM product or a replacement for GitHub.

- **Existing workspace = customer account.** Retain `clients.id` as the tenant identifier; do not create a duplicate customer directory.
- **Project = commercial and delivery anchor.** Each project has deals, agreed resources and deadlines, a billing plan, invoices, and payment history.
- **GitHub = engineering system of record.** Issues, tasks, sprint iterations, repositories, branches, pull requests, and source code remain in GitHub.
- **Website API = commercial system of record.** Agreed scope, rates, billing schedules, invoice snapshots, and payment allocations belong here.
- **Actual workspace owners = financial audience.** They can access finances across every project in their workspace. Being a project creator, project owner, workspace admin, or global SGS administrator is insufficient on its own.
- **SGS AI = invoice issuer.** Customer owners review deals, approve scope or billable work, download invoices, and track payments; they cannot issue invoices or mark themselves paid.
- **Currency and tax are configurable, but jurisdiction is a launch gate.** No production tax invoices until the issuer's legal and tax requirements have been validated.

This proposal addresses the billing/invoicing deferral in the earlier [OneAI platform plan](oneai-client-platform-plan.md). That plan remains historical context; this document does not claim CRM already exists or change an accepted architecture decision automatically.

### Initial scope

| Include in the first release | Defer |
| --- | --- |
| One deal pipeline, project associations, proposal versions, accepted scope | Lead capture, contact campaigns, marketing automation, CRM marketplace sync |
| Fixed-price/milestone and resource-hour billing | Retainers, subscription billing, daily-rate variants, multi-entity consolidation |
| Resource allocations, rate snapshots, approved time, deadlines, budget alerts | Payroll, leave management, advanced capacity optimization |
| Draft/issued invoices, authenticated PDF download, manual payment reconciliation | Payment gateways, automatic bank feeds, accounting-system synchronization |
| Partial payments, credit adjustments, correction and reversal history | Full general ledger, automated revenue recognition, accounts payable |
| GitHub App, issue/task views, sprint views, PR links, controlled task updates | Code hosting/editor, automatic repository provisioning, arbitrary bidirectional sync |
| Owner-only financial dashboards and durable finance audit events | Broad staff finance roles, customer-facing public payment links |

Legally required capabilities cannot be deferred merely because they appear in the future list. For example, mandatory e-invoicing would block invoice issuance until supported.

## 2. Existing architecture and required extensions

The current [architecture](../architecture.md), [data model](../data-model.md), and [API](../api.md) already provide:

- Framework-free HTML/CSS/ES modules, a Node API, Nginx, Firestore, and private Cloud Storage.
- Customer workspaces, membership roles, project CRUD, inline milestones, products, private assets, email, and audit events.
- `projects.owner_user_id`, which currently defaults to the project creator. It is not a financial authorization boundary.
- A service worker that bypasses API responses, plus a workspace snapshot in browser local storage.

Important differences between current behavior and the proposed requirements:

| Current implementation | CRM design requirement |
| --- | --- |
| `requireMembership()` treats global SGS admins as owners everywhere | Introduce an actual-membership finance guard without that bypass |
| Membership management also uses the effective owner role | Prevent non-owner SGS admins from granting themselves or others owner access, including through invitations |
| Generic assets authorize by workspace membership | Financial documents need owner-only metadata and download authorization |
| Project deletion schedules Firestore TTL after 30 days | Projects with finance history must be archived/retained, not automatically purged |
| `writeAudit()` is best-effort with 90-day retention | Financial mutations need a durable event written in their transaction and an approved retention policy |
| `updateDoc()` transacts one document | Invoice issuance, numbering, billing claims, and allocations need a multi-document transaction abstraction |
| Existing lists sort/page after bounded reads | Finance lists and totals need indexed cursor queries and complete, reconciled aggregates |
| Client list/UI may show an SGS admin's effective role as owner | Supply server-calculated finance capabilities based on actual membership; do not infer them from `my_role` |

Keep the existing stack and deployment boundary. Add cohesive CRM route/service modules; do not introduce a frontend framework, a separate CRM microservice, or a database migration for this release.

## 3. Product model and access

### 3.1 Customer and project relationship

```text
Customer workspace (existing clients/{client_id})
  +-- Projects
       +-- Deals and accepted commercial revisions
       +-- Resource allocations and approved time
       +-- Billing plan and billing schedule items
       +-- Invoices, credits, and payment allocations
       +-- GitHub repository and Projects v2 bindings
```

In v1, each deal and invoice belongs to exactly one project and one workspace. A project may have a base deal plus later change-order deals. Create a draft project for a pre-delivery opportunity; do not require a separate unassociated sales module.

Multiple projects can run concurrently for one customer. Different customers can never share commercial records, billing profiles, cached financial totals, or payment allocations.

### 3.2 Permission matrix

All human finance access requires an active `memberships` document with role exactly `owner`, revalidated server-side.

| Actor | Commercial read | Deal/billing preparation | Customer acceptance | Issue/correct invoices; reconcile payments |
| --- | --- | --- | --- | --- |
| Customer workspace owner | Yes, all workspace projects | No; may request changes | Yes | No |
| Designated SGS issuer operator who is also an actual workspace owner | Yes, that workspace | Yes | Cannot impersonate customer acceptance | Yes |
| Workspace admin/member/viewer | No | No | No | No |
| Project creator/`owner_user_id` without workspace owner membership | No | No | No | No |
| Global SGS admin without actual workspace owner membership | No | No | No | No |
| Background service identity | Only records needed for an authorized job | Only the recorded command | No | Only completion of an already authorized operation |

Issuer authority is an additional server-managed entitlement for designated SGS personnel, not a boolean editable by customer owners. It never substitutes for owner membership. Per the kickoff decision, one platform administrator may provision or revoke an issuer-operator assignment with a mandatory reason and durable audit event. Do not equate every global `admin` with an issuer operator.

Customer acceptance must be performed by an owner with global role `user`, not an SGS administrator or issuer operator. Workspaces need at least one such customer approver before accepting a deal or time statement. SGS-only pilot workspaces cannot fabricate customer acceptance.

### 3.3 Guardrails

1. Implement `requireFinanceOwner(user, clientId)` using the authenticated active user, existing workspace, and actual active membership. Layer `requireIssuerOperator()` over it for SGS-only actions.
2. Resolve a resource's stored `client_id` and `project_id`; never authorize from request parameters alone. Require every linked record to match both identifiers.
3. Use `404` for another tenant's resources. An authenticated in-workspace non-owner may receive `403` without finance metadata. Lists, counts, exports, audit views, PDF routes, and finance capabilities follow the same policy.
4. Keep finance out of ordinary project/client DTOs, generic assets, public catalog, analytics payloads, and browser offline snapshots.
5. Restrict granting, changing, removing, inviting, accepting, and resending owner memberships to actual owners, including revalidation when an owner invitation is accepted. Cancel pending owner invitations when their granting authority is revoked.
6. Preserve current nonfinancial administrator support where possible. Any necessary ownership-management behavior change must be documented and tested explicitly.
7. Workspace creation may bootstrap its authenticated creator as the initial owner. Existing workspaces require an ownership review; do not backfill ownership from `project.owner_user_id` or grant global admins ownership in bulk.
8. Recheck owner/issuer authority inside financial commit transactions. After membership revocation, further reads and writes fail, including queued jobs that have not yet performed their authorized effect.
9. Financial documents use authenticated API download streams, not public URLs or long-lived bearer links. Already downloaded files cannot be revoked.
10. Application owner-only access is not protection against trusted infrastructure/database operators. IAM, deployment approval, backup access, and operational auditing remain separate controls.

## 4. Workflows and business rules

### 4.1 Deals: HubSpot-style pipeline, project-specific scope

Start with one fixed pipeline:

| Stage | Default probability | Required information |
| --- | --- | --- |
| Qualified | 10% | Project, customer, SGS deal owner, target close date |
| Discovery | 25% | Scope summary, assumptions, resource estimate, target delivery |
| Proposal | 50% | Versioned price, currency, scope, billing method, schedule, expiry |
| Negotiation | 75% | Proposed changes, current proposal version, next action |
| Closed won | 100% | Customer acceptance of the exact commercial revision |
| Closed lost | 0% | Reason and closed date |

These are SGS defaults, not asserted HubSpot defaults. Probabilities are forecasts, never payment or invoice status.

Flow:

1. SGS issuer operator creates a deal under an existing/draft project.
2. Capture deliverables, exclusions, planned effort by resource/role, dates, currency, rates, fixed price or cap, and payment terms.
3. Publish a proposal revision for customer review; edits create a new revision and invalidate acceptance of the old one.
4. Customer owner accepts that revision. SGS closes the deal won; a transaction activates its billing plan once.
5. Delivery changes use a linked change-order deal and new accepted plan revision. Previously issued invoice lines remain unchanged.

A lost or open deal cannot authorize invoicing. Reopening a won deal must not erase the accepted revision, active obligations, or invoice history. Forecast summaries group by currency and exclude won/lost deals from the open pipeline.

### 4.2 Resources, estimates, and deadlines: Zoho-style project billing

Support two methods initially:

**Fixed price with milestone schedule**

- An accepted fixed amount covers agreed scope, independently of estimated engineering cost.
- Resource allocations support planning and deadline risk, not automatic changes to customer price.
- Each billing item has a stable ID, accepted amount, trigger, planned date, and optional acceptance requirement.
- Triggers: accepted kickoff/deposit, calendar date, or customer-accepted milestone.
- Partial invoicing tracks claimed amount atomically; the schedule cannot exceed the accepted contract amount unless a change order is accepted.

**Time and materials**

- Effective-dated project or resource sell rates; optional not-to-exceed cap.
- Time entries record resource, work date, duration in integer minutes, description, and optional GitHub issue reference.
- SGS prepares a time statement; customer owner approves the exact set/version before invoicing.
- Only approved, unbilled entries are billable. Corrections after billing require a credit/rebill trail, not editing billed time.
- In v1, SGS issuer operators enter/import time; no general staff finance/timesheet portal is required.
- Reserve approved billable units transactionally so overlapping invoices cannot bill the same work twice.

Resource planning records planned minutes, assignment date range, working calendar, and weekly capacity. Compare allocated effort with available capacity within the deadline; show assumptions and warnings rather than promising an exact delivery forecast.

Deadline rules:

- Keep project delivery dates, milestone acceptance dates, invoice issue dates, and invoice payment due dates distinct.
- A missed deadline raises a risk alert. It never changes agreed price, imposes penalties, or issues an invoice automatically.
- GitHub issue completion or PR merge is delivery evidence, not customer acceptance or proof of billable time.
- Date-only deadlines use the workspace timezone; events use UTC ISO timestamps.
- Billing milestones must have stable IDs. Do not reference the array position of an existing inline project milestone.
- Deadline or scope changes affecting charges require a new accepted commercial revision.

### 4.3 Invoices and delivery

Separate legal document state, delivery state, and settlement state:

| Dimension | States |
| --- | --- |
| Document | `draft`, `issued`, `void` where legally permitted |
| Delivery | `not_requested`, `pending`, `sent`, `failed` |
| Settlement | Derived: `unpaid`, `partially_paid`, `paid`; show credited/void amounts separately |
| Collection | Derived: `current`, `overdue` |

Issuance sequence:

1. SGS prepares a draft from eligible billing items or approved time.
2. API recalculates totals, checks accepted scope, cap, customer approval, issuer authority, and legal configuration.
3. A transaction checks versions, claims billable units, allocates a unique invoice number, freezes issuer/customer/line/tax snapshots, and writes the financial event and PDF-generation outbox job.
4. A worker generates a PDF from the immutable snapshot, writes a private object and checksum, then creates the notification job.
5. Customer owners receive a minimal authenticated website link; no finance totals, bearer download URLs, or invoice attachments in email.
6. Delivery failures remain visible and retryable. PDF/email failure does not roll back an already issued legal invoice or reuse its number.

An issued invoice is immutable. Use legally valid void/reissue or credit-note adjustments with linked reasons. Include credit notes and payment reversals in the initial correctness scope, even if their UI is deliberately small.

PDF generation needs one reviewed server-side library selected during the implementation spike. Prefer direct PDF rendering over introducing headless Chromium into the current small container. Validate Unicode fonts, long descriptions, page breaks, totals, legal fields, and file size before selecting it.

### 4.4 Payments and credits

- Initial release records verified offline/bank payments; it does not collect card data.
- Customer owners may report a payment reference, but only SGS issuer operators confirm receipt and allocate it.
- One receipt belongs to one workspace and currency; allocations reference invoices of that same workspace and currency.
- Support partial payments and unallocated customer credit. Avoid silently allocating overpayments.
- A payment reversal is an appended, reasoned record that restores balances; never delete a payment.
- Credit notes reduce receivables and retain tax treatment; refunds are separate cash movements, not negative invoice edits.
- Invoice financial and PDF history survives workspace/project closure and user anonymization, subject to approved legal retention.

### 4.5 Money and a worked example

- Store money in integer minor units with an ISO currency and configured currency exponent; do not assume every currency has two decimal places.
- Store durations in integer minutes and tax percentages in basis points. Validate safe-integer bounds.
- Hourly amounts use integer/rational arithmetic: `minutes * hourly_rate_minor / 60`, rounded by the documented rule. Do not use JavaScript floating-point totals.
- V1 supports one currency per accepted project billing plan; invoices and allocations use that currency. No FX conversion or cross-currency totals.
- Define and snapshot tax inclusion, discount order, per-line rounding, tax components, and any final rounding adjustment. Validate rules for the selected jurisdiction.
- Expected contract value, invoiced net amount, cash received, outstanding receivable, and accounting revenue are different metrics.

Illustration only, in currency units and excluding tax:

| Item | Calculation |
| --- | --- |
| Development estimate | 100 hours x 1,000 = 100,000 |
| QA estimate | 20 hours x 1,000 = 20,000 |
| Fixed-price agreement | 120,000, explicitly accepted; not automatically derived from the estimate |
| Billing schedule | 30% kickoff = 36,000; 40% accepted build = 48,000; 30% accepted delivery = 36,000 |
| First invoice/payment | Issue 36,000; receive 20,000; remaining invoice balance 16,000 |
| Delivery slippage | Move forecast/risk indicators; do not change 120,000 or the issued 36,000 invoice |

For T&M, those same 120 hours are billable only when actually recorded, approved, and not already invoiced. A closed GitHub issue contributes zero billable minutes by itself.

Outstanding receivable is issued gross less valid credit allocations and net payment allocations, excluding void documents. Age unpaid balances by invoice due date into current, 1-30, 31-60, 61-90, and 90+ day buckets. Keep cash, credits, and refunds separately reconcilable.

## 5. GitHub integration

### 5.1 Ownership and user experience

Connect selected repositories and an existing organization-owned GitHub Projects v2 board to each website project. Start with organization-owned boards; verify any future user-owned board support separately.

| GitHub surface | Website behavior |
| --- | --- |
| Issues and task-list/sub-issue relationships | Delivery list with title, status, assignee, labels, milestone, and GitHub link |
| Projects v2 iteration field | Current/upcoming sprint, dates, grouped work, and completion counts |
| Projects v2 status and effort fields | Map configured field/node IDs; do not rely on display names |
| Pull requests | State, review/merge metadata, related issues, and native GitHub links |
| Repositories, branches, commits, source | Open native GitHub; code editing, branch protections, reviews, and merges remain there |

SGS issuer operators with actual owner membership may create an issue or request a status/iteration change through explicit website commands. GitHub is authoritative; the website shows pending/failed commands and then reflects confirmed remote state. Other delivery users retain existing project access but do not gain financial data.

Do not grant website customers GitHub organization membership automatically. Do not proxy private source files through the website. A GitHub App token's access is not proof that a website user should see all its repositories or issue descriptions.

V1 defaults to a dedicated repository/board scope per customer. Shared boards may be used only when every mirrored item is explicitly mapped to an authorized project/repository. Exclude board-only drafts and unrelated items from customer views; never import a whole mixed-customer board and filter only in the browser.

### 5.2 App and permission model

Use a GitHub App with installation tokens, not a shared personal access token.

- Request repository metadata read, Issues read/write for supported commands, Pull requests read, and organization Projects read/write for iteration/status commands.
- Limit the installation to selected repositories; bind numeric installation/repository IDs and GraphQL project/field IDs server-side.
- No Administration, Contents write, Workflows write, or repository creation in v1.
- Native source-code links need no Contents permission. Add Contents read only if a later approved feature needs commit/source APIs; PR metadata is sufficient initially.
- Store the private key and webhook secret in Secret Manager. Keep tokens server-side, short-lived, and absent from logs and browser responses.
- Installation/setup callbacks require an authenticated actual owner, issuer entitlement, expiring state bound to the workspace, and verification that the installation includes the intended repositories.
- Repository binding is an explicit data-sharing decision approved during customer onboarding. Never accept arbitrary repository URLs as authority.

Validate all required REST/GraphQL operations and webhook subscriptions in a sandbox before finalizing permissions. GitHub permissions are API-operation-specific; classic PAT scopes are not GitHub App permission names.

### 5.3 Reliable synchronization

```text
GitHub webhook
  -> bounded raw body + HMAC verification
  -> durable inbox/outbox transaction
  -> fast acknowledgement
  -> authenticated queued worker
  -> tenant-scoped normalized delivery cache

Website command
  -> owner/issuer + binding validation
  -> durable command/outbox
  -> GitHub API
  -> reconciliation -> confirmed website state
```

- Verify `X-Hub-Signature-256` against the original bytes with timing-safe comparison before processing JSON.
- Deduplicate by installation and delivery ID. Derive tenancy from verified bindings, never a payload's claimed `client_id`.
- Initially subscribe to installation/repository access changes, issues, pull requests, and applicable Projects v2 item events after permission verification.
- Re-fetch authoritative state for out-of-order events. Record synchronization version/time and avoid stale overwrites.
- Use bounded pagination, rate-limit headers, exponential backoff with jitter, and a visible terminal failure/retry path.
- Run periodic reconciliation for missed events and iteration/field changes not covered by available webhooks.
- On uninstall/access revocation, disable commands and customer delivery reads from that binding until access is restored; retain only operational history required by policy.
- Never send deals, rates, time approval, invoice data, payment references, or customer billing addresses to GitHub.

Use Cloud Tasks for bounded work and Cloud Scheduler for reconciliation/outbox dispatch, with OIDC-authenticated internal API handlers. Reuse the current application image; do not rely on in-process timers or work continuing after a request on scale-to-zero Cloud Run.

Accept a webhook only after inbox/outbox persistence succeeds. A scheduled dispatcher retries unsent outbox rows if immediate enqueue fails. Workers use leases and idempotent handlers; expired leases are recoverable. A queue outage is visible as pending work, not fake synchronization success.

For issue creation, handle the ambiguous case where GitHub accepted a request but the response was lost: persist a command identifier, reconcile a nonfinancial correlation marker before retrying creation, and require operator resolution when uniqueness cannot be established.

## 6. Proposed data model

Keep snake_case fields and the existing API-only Firestore boundary. This table describes new collections, not current ones. Tenant-owned rows carry `client_id`; project-level rows also carry `project_id`. Global issuer configuration and integration ingress records have restricted service-only access.

| Collection | Main fields / invariant |
| --- | --- |
| `issuer_profiles` | Legal name/address, tax registrations, bank instructions, jurisdiction, timezone, numbering policy; versioned global issuer configuration |
| `issuer_operators` | Restricted `user_id` entitlement; who granted/revoked it and when; no customer-editable endpoint |
| `billing_profiles` | `client_id`, legal customer name/address/tax IDs, billing contacts, currency defaults, terms, timezone; owner-only |
| `deals` | `client_id`, `project_id`, stage, probability, expected amount/currency, expected close, SGS owner, current proposal revision, outcome reason, version |
| `commercial_revisions` | Immutable scope, deliverables, exclusions, rate/price snapshots, dates, terms, customer acceptance identity/time, predecessor revision |
| `resource_allocations` | Project, resource label/optional user ID, role, planned minutes, capacity calendar, start/end dates, sell-rate reference, commercial revision |
| `time_entries` | Resource, work date, minutes, description, optional GitHub reference, version; billing state controlled by claims |
| `time_statements` | Immutable/versioned entry set, total minutes/amount, approval actor/time, rejected reason; changing entries invalidates approval |
| `billing_plans` | Accepted revision, fixed/T&M method, currency, cap, effective dates, version; only one active base plan |
| `billing_items` | Stable ID, plan/revision, amount or eligible units, trigger, due/acceptance state, claimed amount; no positional milestone references |
| `invoices` | Project, unique number, issue/due date, immutable issuer/customer/line/tax snapshots, totals, document version/state, PDF object/checksum, delivery state |
| `billing_claims` | Deterministic source-unit identity and invoice/line association; prevent concurrent double billing |
| `credit_notes` | Original invoice, immutable correction lines/taxes, reason, issuer, number, allocations |
| `payments` | Workspace/currency, verified receipt amount/date/reference, unallocated balance, confirmation identity; no card data |
| `payment_allocations` | Receipt, invoice, amount, immutable allocation/reversal entries |
| `financial_events` | Append-only actor/action/target, project/workspace, reason, version, request/idempotency references; no short default TTL |
| `invoice_counters` | Issuer, numbering series/fiscal period, next sequence; global restricted, transacted with issuance |
| `idempotency_records` | Actor/workspace/operation/key, request hash, committed result; retention defined by replay risk |
| `github_installations` | Installation/account IDs, access state, selected repository metadata; service-only credentials references |
| `github_bindings` | Workspace/project, approved repository IDs, Project v2 ID, mapped field IDs, access approval, last reconciliation |
| `github_work_items` | Authorized normalized issue/PR/project-item metadata, remote IDs and versions; no financial fields |
| `integration_inbox`, `outbox_jobs` | Verified event/command identity, safe payload reference, state, lease, retry count, next attempt, terminal error |

Implementation requirements:

1. Extend `db.mjs` with a multi-document transaction API, create-if-absent semantics, and indexed cursor queries. Domain services must not call Firestore directly.
2. Mirror transaction serialization/atomic failure behavior in the memory adapter; test concurrency explicitly.
3. Transactionally commit invoice snapshot, counter, claims, idempotency result, financial event, and outbox record. Bound line/claim counts to remain safely below Firestore limits.
4. Require `If-Match` on mutable financial records. Return the repository-standard `412` for stale versions; do not make it optional as existing project updates do.
5. Require `Idempotency-Key` for issuance, deal activation, payment confirmation/allocation, credits/reversals, and GitHub commands. Same key/body returns the committed result; changed body returns `409`.
6. Never silently truncate financial queries at existing 1,000/5,000-document caps. Index by tenant/project/status/date with stable ID tie-breakers; cursor responses use `{items, next_cursor}` and documented optional totals.
7. Derive small project totals from complete source queries or maintain transactionally reconciled summaries. Summary documents also require owner-only access.
8. Store PDFs in a private finance prefix, outside generic asset listing/download routes. Serve with authenticated owner checks, `Cache-Control: no-store`, safe content type, and attachment filename.
9. Apply finance authorization before generic audit responses can expose financial events or owner-sensitive membership changes. Keep detailed financial diffs out of the existing global admin audit feed.
10. Do not apply short TTLs to invoices, credits, payments, financial events, counters, or referenced projects. Establish retention, legal holds, backup, recovery, and object lifecycle policies before launch.
11. Block project hard/TTL deletion once finance records exist, and preserve the retained parent identity. Archive the project instead. Test account deletion and workspace closure against finance retention.
12. Production remains fail-closed when Firestore is unavailable; no memory fallback for financial writes.

## 7. API and website design

### 7.1 Proposed routes

These are planned `/api/v1` additions, not working endpoints. Continue the existing error envelope, body-size checks, sanitization, authentication, and rate limits.

| Route group | Actions and access |
| --- | --- |
| `/clients/:client_id/crm/capabilities` | Read: actual-owner access, issuer actions, enabled features; no amounts |
| `/clients/:client_id/crm/summary` | Owner-only project/currency totals, pipeline, outstanding and overdue |
| `/clients/:client_id/billing-profile` | Owner read; issuer-only update with customer confirmation of legal details |
| `/projects/:project_id/deals` | Owner list/read; issuer create/update/publish revision/close |
| `/deals/:id/revisions/:revision_id/accept` | Customer-owner acceptance of exact revision |
| `/projects/:project_id/billing-plan` | Owner read; issuer prepare/change; activation from accepted revision |
| `/projects/:project_id/resources` | Owner read; issuer manage estimates and rate references |
| `/projects/:project_id/time-entries` | Owner read; issuer create/update unbilled entries |
| `/projects/:project_id/time-statements` | Owner read; issuer prepare; customer-owner approve/reject specific version |
| `/projects/:project_id/billing-items` | Owner read; issuer manage; customer-owner accept deliverable where required |
| `/projects/:project_id/invoices` | Owner list; issuer create draft |
| `/invoices/:id` and `/invoices/:id/issue` | Owner read; issuer draft update/issue |
| `/invoices/:id/document` | Owner-only authenticated PDF download; explicit pending/failure response |
| `/invoices/:id/notify`, `/invoices/:id/credit-notes` | Issuer-only retry notification/correct issued document |
| `/clients/:client_id/payments` | Owner read; issuer confirm receipt; customer payment reports remain unverified |
| `/payments/:id/allocations`, `/payments/:id/reversals` | Issuer-only allocate/reverse with immutable history |
| `/projects/:project_id/finance-events` | Owner-only retained commercial/financial history |
| `/projects/:project_id/github` | Authorized delivery reads; owner+issuer binding/command changes |
| `/integrations/github/setup`, `/integrations/github/callback` | Owner+issuer setup with verified installation/state |
| `/integrations/github/webhooks` | Signature-authenticated public ingress, not browser-session authenticated |
| `/internal/crm/jobs`, `/internal/crm/reconcile` | Restricted OIDC service identities only; reject website bearer tokens |

Check that ordinary project updates cannot mutate financial fields, active commercial revisions, or private bindings. Include body/path tenant mismatch tests.

Existing `/api/v1/` Nginx proxying covers these paths. Do not add location-level `add_header` directives. Verify webhook raw-body handling, rate limits, and OIDC audience/identity validation in the real container.

### 7.2 Navigation and screens

Reuse existing workspace switching and project detail navigation.

**Workspace owner CRM page: `/workspace/crm/?client=<id>`**

- Summary cards: open pipeline, accepted contract value, invoiced, cash received, outstanding, overdue; grouped by currency.
- Deal board with table alternative, stage totals, target close dates, next action, project filter.
- Invoice list with project, number, issue/due date, amount, payment balance, overdue and delivery status.
- Customer billing profile and owner-only audit link.

**Existing `/workspace/project/?id=<id>`**

- Preserve Overview, Products, and existing project behavior.
- Add Delivery: issue/task list, current sprint, GitHub links, synchronization health.
- For actual owners only, add Deals, Resources & Billing, Invoices, and Finance History.
- Display deadline/cap warnings, accepted commercial revision, billable/approved/unbilled effort, milestone eligibility, and invoice previews.
- Customer actions: accept/reject proposal, approve time or milestone, request a correction, download PDF, report payment.
- SGS issuer actions: prepare proposal/billing, issue/correct invoice, confirm payment, retry failed jobs.

Supporting details can use `/workspace/invoice/?id=<id>` and `/workspace/deal/?id=<id>` without exposing private data in static HTML.

Accessibility and privacy:

- Use tables/forms and explicit buttons; Kanban drag-and-drop is optional, never the only interaction.
- Provide keyboard navigation, labelled controls, useful empty/loading/error states, and a confirmation summary for irreversible actions.
- Hide finance navigation for non-owners, but enforce all access in the API.
- On workspace switch, sign-out, or permission loss, clear rendered finance state and abort stale requests.
- No financial data in local storage, IndexedDB, service-worker caches, URLs, analytics, or ordinary project snapshots.
- Authenticated finance APIs/PDFs are `no-store`; financial pages can load only an empty static shell when offline.
- New private page routes are `noindex`, excluded from sitemap/public analytics, and added to robots policy/build tests as required.
- Reuse existing CSS tokens, ES modules, root-relative links, asset-version markers, and CSP; no third-party browser CRM SDK.

## 8. Implementation boundaries and documentation

Suggested implementation locations, to refine during each issue:

| Surface | Change |
| --- | --- |
| `src/server/authz.mjs`, membership/invitation routes | Actual-owner finance checks and controlled ownership grants |
| `src/server/db.mjs` | Multi-document transactions, unique creation, cursor querying |
| `src/server/routes/` | Cohesive deals, billing/invoices/payments, GitHub integration route tables |
| `src/server/` domain helpers | Money calculation, commercial state transitions, finance events, GitHub client, PDF rendering, job processing |
| `src/server/server.mjs` | Register routes, raw webhook request handling, injected service adapters, private response headers |
| `public/workspace/`, `public/assets/js/`, `public/assets/css/` | CRM page, project finance/delivery tabs, authenticated PDF downloads |
| `config/firestore/` | Required indexes, index exemptions, retention separation; continue denying client SDK access |
| Infrastructure/deployment configuration | GitHub secrets, Cloud Tasks, Scheduler, service identities, private finance storage and retention |
| `test/` | Owner isolation, lifecycle, calculation, concurrency, integration and build-boundary coverage |
| `docs/` | Architecture, API, model, rollout/operations, legal configuration, and proposed finance/integration ADR |

Inject GitHub, PDF, queue/clock, and mail adapters in tests, like the existing storage/mail approach. Do not require live credentials, SMTP, GitHub, Firestore, or Cloud Storage for the normal test suite.

## 9. Delivery sequence and estimates

Planning estimate: **8-10 weeks** with two engineers plus part-time QA, design/product, and finance review. This is not a committed deadline; re-estimate after the first spike. Legal decisions, GitHub installation approval, and infrastructure provisioning are external dependencies.

| Phase | Indicative effort | Deliverable and exit gate |
| --- | --- | --- |
| 0. Decisions and spikes | 3-5 working days | Confirm issuer/jurisdiction, customer approvers, current owner memberships, GitHub permissions/board model, transaction limits, PDF prototype |
| 1. Foundation | 1-1.5 weeks | Owner/issuer guards; ownership escalation protections; atomic repository helpers; money rules; finance retention; authorization tests pass |
| 2. Deals and accepted scope | 1 week | Pipeline, revision acceptance, idempotent won-to-billing activation, CRM/project navigation |
| 3. Billing and resource/time approval | 1-1.5 weeks | Fixed milestones and T&M; stable IDs; cap/deadline warnings; no double billing in concurrency tests |
| 4. Invoices and receivables | 1.5-2 weeks | Numbered immutable invoices, private PDF, durable jobs, delivery retries, payments, credits and reversals; finance sign-off |
| 5. GitHub delivery integration | 1-1.5 weeks | Scoped App binding, issues/sprints/PRs, explicit commands, verified webhooks, reconciliation and outage handling |
| 6. Pilot and release | 1 week | One consenting customer workspace, both billing methods, restore drill, full regression/container checks, operational handover |

Phases 2-4 depend on phase 1; phase 3 uses accepted scope from phase 2; phase 4 uses billable eligibility from phase 3. GitHub work can proceed after phase 1 without blocking manual milestone/time approval. Public rollout requires all release gates below.

### Suggested implementation work packages

1. **CRM-01:** approve ownership/issuer matrix, billing jurisdiction, scope and finance ADR.
2. **CRM-02:** actual-owner capabilities and membership/invitation escalation protections.
3. **CRM-03:** atomic transaction/idempotency/cursor primitives and finance event retention.
4. **CRM-04:** money, tax, invoice counter and billing calculation rules with fixtures.
5. **CRM-05:** billing profiles, deal pipeline, commercial revisions and customer acceptance.
6. **CRM-06:** resources, stable billing milestones, T&M time statements and caps.
7. **CRM-07:** invoice issuance, billing claims, immutable snapshots and legal corrections.
8. **CRM-08:** private PDFs, outbox/Cloud Tasks, notifications and retry UI.
9. **CRM-09:** receipts, allocations, reversals, credits and reconciled owner dashboards.
10. **CRM-10:** GitHub App setup, verified bindings and tenant-safe delivery reads.
11. **CRM-11:** webhook inbox, reconciliation, sprint mapping and controlled issue commands.
12. **CRM-12:** pilot, access/restore/load testing, documentation and staged release.

Dependencies: 02 depends on 01; 03 and 04 depend on 01; 05 depends on 02-04; 06 depends on 05; 07 depends on 06; 08 depends on 07; 09 depends on 07-08; 10 depends on 02-03; 11 depends on 10; 12 depends on 09 and 11. These are planning identifiers only; no GitHub issues or boards have been created.

## 10. Verification and release gates

### Required automated acceptance

| Area | Measurable acceptance |
| --- | --- |
| Owner isolation | Owner of A cannot list, count, fetch, export, download, or mutate any finance record of B |
| Actual ownership | Workspace admin/member/viewer, project creator, and nonmember SGS admin receive no finance data |
| Escalation | Non-owner SGS admin cannot self-grant owner or issue/accept/resend an owner invite to gain access |
| Issuer separation | Customer owner cannot issue/void/credit an invoice, confirm cash, or provision issuer authority |
| Revocation | Owner removal blocks the next API call and uncommitted queued effects; retained files are never publicly accessible |
| Deal versioning | Accepting a stale proposal fails; ten replays of a won/activation command produce one active plan |
| Billing | 20 concurrent attempts to bill one eligible item create at most one claim for that amount/unit |
| Time approval | Unapproved, modified-after-approval, already billed, wrong-tenant, or over-cap time cannot be issued |
| Numbering | 20 parallel distinct eligible invoice issues have unique numbers; failed precommit operations claim no billable units |
| Idempotency | Ten retries of issue/payment/credit produce one financial result; changed payload with the same key returns `409` |
| Calculations | Exact fixtures for 0/2/3-decimal currencies, minute rounding, discounts, tax-inclusive/exclusive lines, partial credits, and large bounded amounts |
| Settlement | Partial payment, unallocated overpayment, allocation reversal, credit and refund scenarios reconcile to original documents |
| Retention | Archive/delete/anonymize flows preserve required finance documents and parent references; no 30-day project TTL loss |
| Audit durability | Financial commit cannot succeed without its financial event; notification failure cannot erase an issued invoice |
| GitHub boundary | Invalid HMAC rejected; ten deliveries of one event applied once; cross-customer repository/board items never exposed |
| GitHub failures | Out-of-order events, uninstall, revoked repository, lost command response, rate limits, and dead-letter retries have explicit outcomes |
| PDF/privacy | Owner-only download; correct snapshot/totals; long/Unicode multipage rendering; no finance in browser caches, snapshots, analytics or logs |
| Existing behavior | Account, workspace, project/product, asset and public-site regression suites remain green except approved ownership-management changes |

Use the existing test helpers and injected fakes for deterministic tests. Add a dedicated staging integration check for real Firestore transaction contention/indexes, private storage, queue OIDC, and GitHub App permissions; in-memory tests cannot certify these services.

### Operational and performance targets

- Pilot load assumption: 50 customer workspaces, 20 projects each, and 1,000 invoices per workspace. Verify indexed cursor paging and no tenant-wide capped scans.
- Under a documented staging test of 20 concurrent users, p95 finance list/detail API latency below 1 second, excluding downloads and external GitHub calls.
- Valid webhook durable acknowledgement p95 below 2 seconds; typical event-to-view freshness below 2 minutes.
- Reconcile delivery metadata at least every 15 minutes; show last-sync time and a stale warning after 15 minutes without a successful sync.
- Alert on exhausted jobs immediately and on oldest pending issuance/PDF/notification work exceeding 10 minutes.
- Target daily verified backups, recovery point within 24 hours, and recovery within 4 hours; approve cost/retention and demonstrate a restore before production issuance.
- Financial totals reconcile exactly to source documents; no tolerated rounding drift or cross-currency combined totals.

### Repository validation for implementation PRs

```sh
npm run lint
npm test
npm run build
npm run check:dist
docker build -t sgs-ai-website:local .
bash scripts/check-container.sh sgs-ai-website:local
```

Run focused tests during development, then the documented minimum checks and container validation before release. Validate owner/non-owner flows in a browser and verify responsive, keyboard-accessible screens. Lighthouse budgets should be checked for affected routes where configured and feasible.

The initial milestone adds focused authorization, transaction, deal lifecycle and browser-facing coverage. The complete acceptance matrix above remains the release gate for the full roadmap; it is not a claim that all later workflows exist or pass.

## 11. Rollout, migration, and operations

1. Introduce server-enforced per-workspace feature flags for CRM read, finance issuance, and GitHub integration. UI flags are not authorization.
2. Audit current actual owners and designate SGS issuer operators; obtain customer consent for SGS owner membership and GitHub data sharing.
3. Add collections/indexes and retention policies before enabling writes. Leave current projects untouched by default.
4. Opt selected projects in explicitly. Map eligible legacy milestones to stable IDs once; do not infer contracts or opening balances from old project descriptions.
5. Enter opening invoices/receipts only through a reviewed import with source references and duplicate checks; otherwise begin with new invoices only.
6. Pilot one consenting workspace with fixed-price and T&M examples. Validate a real legal invoice only after finance approval; do not send test invoices to customers.
7. Enable further workspaces after access, reconciliation, backup/restore, and job-retry gates pass.
8. On rollback, disable new commands and issuance, retain owner read/download and reconciliation as safe, and preserve every already issued number/document. Never restore an older app version that can purge finance-linked projects or bypass new ownership rules.

Runbook must cover issuer/key rotation, failed PDF regeneration from immutable snapshots, ambiguous email delivery, queue replay, payment correction, GitHub token/access revocation, finance data export, legal holds, and restore/reconciliation procedures.

Log request/job IDs and sanitized failure codes, not invoice bodies, bank details, GitHub credentials, or raw webhook bodies. Apply a short approved retention to operational payloads separately from finance records.

## 12. Decisions required before implementation / launch

Already confirmed for this plan:

- Existing workspace is the customer account.
- Workspace owners access finances for every project in that workspace.
- Global SGS admins have no automatic financial access; actual owner membership is required.
- SGS issues invoices; customer owners review and track payment.
- Currency/tax configuration is required; jurisdiction remains unconfirmed.

Remaining gates:

1. Issuer legal entity, billing country, tax registration, required invoice/credit fields, numbering and fiscal-year rules.
2. Initial supported currencies, tax calculation/rounding rules, mandatory e-invoicing, and record-retention period, approved by a qualified finance/tax reviewer.
3. Named SGS issuer operators and customer approvers for each pilot workspace.
4. Agreed terms: deposit versus advance accounting, acceptance evidence, net payment days, permitted corrections and refunds. No automatic late fees in v1.
5. GitHub organization/repository ownership, App installation approvals, dedicated versus shared board boundaries, and sprint field mappings.
6. Infrastructure budget/owners for queues, scheduling, secrets, backups, storage retention, and PDF capacity.
7. Final priority if delivery must be shortened: release fixed-price billing first behind its own gate; do not claim resource-hour billing complete until approval/claim tests pass.

## 13. Design references

Consulted 2026-11-03. These are pattern references, not a proposal to purchase, embed, copy proprietary UI assets, or synchronize with either CRM:

- [HubSpot: Pipelines API](https://developers.hubspot.com/docs/api-reference/2026-03/crm/pipelines/guide) documents staged pipelines and deal probabilities, including closed-won/lost semantics.
- [Zoho Invoice: Projects API](https://www.zoho.com/invoice/api/v3/projects/) associates projects with customers and supports fixed/project/staff/task-hour billing and billed/unbilled effort.
- [Zoho Billing: basic project functions](https://www.zoho.com/us/billing/help/time-tracking/projects/basic-functions.html) describes resource/time-based billing and customer approval of time before invoicing.
- [GitHub: choosing App permissions](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app) supports least-privilege installation design.
- [GitHub: Projects API](https://docs.github.com/en/issues/planning-and-tracking-with-projects/automating-your-project/using-the-api-to-manage-projects) documents GraphQL project IDs, authentication and operation-specific permissions.
- [GitHub: iteration fields](https://docs.github.com/en/issues/planning-and-tracking-with-projects/understanding-fields/about-iteration-fields) provides the sprint model.
- [GitHub: webhook validation](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries) documents raw-payload HMAC verification and timing-safe signature comparison.
