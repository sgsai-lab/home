# API reference

The Node API (`src/server/`) serves the website and the mobile app (ADR-002). Nginx proxies `/api/v1/*`, `/go/*`, `/api/readyz`, the legacy `/api/contact|config|analytics` endpoints and the two `/.well-known/` association files to it.

## Conventions

- JSON in and out. `/api/v1` errors use `{ "error": { "code", "message", "details": [{ "field", "message" }], "request_id" } }`; wrong methods return `405` with `Allow`.
- Authentication: `Authorization: Bearer <access_token>` (1 hour). Refresh tokens rotate on every use and are single-use; presenting a spent one revokes that session family.
  - Web (default): the refresh token is an `HttpOnly; Secure; SameSite=Strict` cookie scoped to `/api/v1/auth`.
  - Mobile: send `X-Client: mobile` and `X-Client-Platform: android|ios`. Sign-in responses include `refresh_token`; refresh with `POST /auth/token/refresh {"refresh_token"}`; sign out with `POST /auth/logout {"refresh_token"}`.
- Roles: global `role` is `user` or `admin` (SGS staff). Workspace roles are `viewer < member < admin < owner`; SGS admins act as owners everywhere. Requests for another tenant's data return `404`, never the data.
  - Exception: CRM finance requires an actual active workspace `owner` membership. Global administrators have no finance bypass. Granting/changing/removing owners and creating/resending owner invitations also require actual ownership.
- Lists accept `page`, `page_size` (max 50, 100 for products) and `sort` (`field` or `-field`) and return `{ items, total, page, page_size }`.
- Rate limits answer `429 RATE_LIMITED` with `Retry-After`: sign-in family 10/15 min per IP and per email, MFA 10/15 min, mutations 60/10 min per user, invitations 10/h per workspace, upload URLs 20/h per user, launches 120/min. Limits are per instance (at most 5 instances).
- `503 SERVICE_UNAVAILABLE` means Firestore is unreachable (production never falls back to memory); `503 STORAGE_NOT_CONFIGURED` / `MFA_UNAVAILABLE` / `PROVIDER_NOT_CONFIGURED` mean an optional integration is not configured.

## Health and configuration

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/api/readyz` | `{status, database: firestore\|memory}`; `503` when Firestore is unreachable |
| GET | `/api/config` | Public Google and Apple client ids for the web sign-in buttons |
| GET | `/.well-known/assetlinks.json`, `/.well-known/apple-app-site-association` | Built from `ANDROID_CERT_SHA256` / `APPLE_TEAM_ID`; `404` until configured |

## Authentication (`/api/v1/auth`)

| Method | Path | Body → result |
| --- | --- | --- |
| POST | `/signup` | `{full_name, email, password, accept_terms: true, invite_token?}` → `201 {email, verification_required}`. Same answer for existing emails. A matching invite verifies the address and joins the workspace. |
| POST | `/login` | `{email, password}` → tokens + `user`, or `{mfa_required, mfa_token}`. `401 INVALID_CREDENTIALS`, `403 EMAIL_NOT_VERIFIED`, `403 ACCOUNT_DISABLED` |
| POST | `/verify-email` | `{token}` (24 h, single use) |
| POST | `/verify-email/resend` | `{email}` → always `200` |
| POST | `/password/forgot` | `{email}` → always `200`; link valid 1 h |
| POST | `/password/reset` | `{token, new_password, mfa_code? \| recovery_code?}`; signs out every session. `400 MFA_REQUIRED` when 2FA is on |
| POST | `/password/change` | `{current_password, new_password}`; keeps this session, revokes others |
| POST | `/password/set` | `{new_password}` for Google/Apple-only accounts |
| POST | `/google`, `/apple` | `{id_token, nonce?, full_name?}`; audiences from `GOOGLE_CLIENT_ID(S)` / `APPLE_CLIENT_ID(S)` |
| POST | `/apple/android-state` | `{package}` → signed `state` for Apple's web flow on Android |
| POST | `/apple/callback` | Apple `form_post` return URL; `303` to `intent://callback?...;scheme=signinwithapple` |
| POST | `/token/refresh` | Rotates the refresh token (cookie or JSON) |
| POST | `/logout`, `/logout-all` | Revokes this session family / every session |
| GET | `/sessions` | `{items: [{id, current, client, device, user_agent, started_at, last_used_at}]}` |
| DELETE | `/sessions/{id}` | Revokes that device's access and refresh tokens |
| POST/DELETE | `/google/link` | Link a Google account / unlink (`409` if it is the only sign-in method) |
| GET | `/mfa` | `{enabled, available, recovery_codes_remaining}` |
| POST | `/mfa/totp/setup` → `/mfa/totp/confirm` | `{secret, otpauth_uri}` → `{code}` → `{recovery_codes: [10]}` |
| POST | `/mfa/verify` | `{mfa_token, code \| recovery_code}` → tokens. 5 wrong codes lock 2FA for 15 min (`429 MFA_LOCKED`) |
| POST | `/mfa/recovery-codes` | `{code}` → new codes |
| DELETE | `/mfa/totp` | `{password \| code}`; revokes other sessions |

## Users

| Method | Path | Notes |
| --- | --- | --- |
| GET/PATCH/DELETE | `/users/me` | Profile with `memberships[]` and `default_client_id`; PATCH `full_name`, `avatar_url`, `default_client_id`; DELETE needs `{password \| code}` (or a sign-in in the last 15 min) and anonymises the account |
| GET/POST | `/users` | SGS admin. Filters `q`, `role`, `status`. POST `{full_name, email, role}` emails a set-password link |
| PATCH/DELETE | `/users/{id}` | SGS admin. `full_name`, `role`, `status` (`active\|disabled`; disabling revokes sessions). Own role/status → `400 SELF_MODIFICATION` |

## Workspaces

| Method | Path | Role |
| --- | --- | --- |
| GET | `/clients` | Members see their workspaces (`my_role`); SGS admins see all (filters `q`, `status`, `sector`) |
| POST | `/clients` | SGS admin. `{name, primary_sector, status?, slug?, contact?, branding?}`; creator becomes owner |
| GET/PATCH | `/clients/{id}` | viewer / admin. Only SGS admins change `status` |
| GET/POST | `/clients/{id}/members` | viewer / SGS admin. POST `{email, role}` adds an existing account directly; workspace admins use invitations so they cannot probe which emails are registered |
| PATCH/DELETE | `/clients/{id}/members/{user_id}` | admin (owners for owner changes); members may remove themselves. Last owner → `409 LAST_OWNER` |
| GET/POST | `/clients/{id}/invites` | admin. POST `{email, role}`; link valid 7 days |
| POST | `/clients/{id}/invites/{invite_id}/resend` | admin; issues a new link and invalidates the old one |
| DELETE | `/clients/{id}/invites/{invite_id}` | admin |
| GET | `/invites/preview?token=` | public: `{client_name, primary_sector, role, email}` |
| POST | `/invites/accept` | `{token}`; email must match (`403 INVITE_EMAIL_MISMATCH`), single use (`410 INVITE_CONSUMED`) |

## Projects

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/projects` | `client_id?`, `q`, `status`, `sector`, `tag`, `deleted=only` (admins). Items carry `can_edit` |
| POST | `/projects` | admin of the workspace. `{client_id, name, sector?, status?, summary?, tags[], start_date?, end_date?, sector_profile?, milestones?, use_template?}` |
| GET/PATCH | `/projects/{id}` | Responses carry `ETag`; PATCH honours `If-Match` (`412 PRECONDITION_FAILED`) |
| DELETE | `/projects/{id}` | Soft delete; purged after 30 days |
| POST | `/projects/{id}/restore` | Within 30 days |

Statuses: `draft, discovery, in_progress, on_hold, delivered, archived`. Sector profiles: business `{engagement_type: advisory|build|managed_service, department}`; education `{institution_type: school|college|university|training, programme, cohort, academic_year}`.

## Project CRM: deals and proposals

The website's `/workspace/crm/?client=<id>&project=<optional-id>` provides standard deal list, read-only record detail, and explicit create/edit forms. Financial responses use `Cache-Control: no-store`; there is no offline financial snapshot.

SGS prepares commercial terms; a customer owner accepts the exact published revision; SGS then activates the accepted base billing plan. Assigned issuer operators must be active global administrators **and** actual owners of the relevant workspace. Customer owners (global role `user`) can review/accept, but cannot prepare or activate deals. SGS administrators cannot accept proposals on a customer's behalf, even without an issuer assignment.

Defaults confirmed for this implementation: INR; India tax jurisdiction with GST initially **unconfigured**; monthly billing at month end; invoice payment due 30 days after issue. The Project finance section below documents resource/time billing, gated invoice issuance, manual payments and corrections. Deals also support additive change orders. See [GitHub CRM](github-crm.md) for delivery integration and its operator configuration requirements. Online payment gateway processing is not included.

Setup:

1. Deploy the CRM Firestore indexes through the normal infrastructure process before using deployed list endpoints.
2. Create/use a customer workspace, and have a current actual owner invite at least one customer approver with workspace role `owner` and global role `user`.
3. In the Admin console's **SGS invoice issuer operators** section, select an SGS administrator, assign authority and provide a reason. Ensure that person has actual owner membership in the customer workspace.
4. Open **Project CRM** from the workspace, select a project and apply the filter, then create a deal. The project detail page also links directly to its CRM view.
5. SGS saves/publishes the proposal; the customer owner signs in to review/accept it; SGS activates the billing plan. No invoice or payment is created by activation.

| Method | Path (under `/api/v1`) | Access / behavior |
| --- | --- | --- |
| GET | `/clients/{client_id}/crm/capabilities` | Actual owner. `can_prepare`, `can_accept`, billing defaults, implementation stage and `invoice_issuance_enabled: false` |
| GET | `/clients/{client_id}/crm/deals` | Actual owner. Optional `project_id` and `stage` filters |
| GET/POST | `/projects/{project_id}/deals` | Actual owner read / assigned issuer create |
| GET/PATCH | `/crm/deals/{id}` | Actual owner read / assigned issuer edit; `ETag` returned; PATCH requires `If-Match` |
| POST | `/crm/deals/{id}/publish` | Issuer. Empty JSON body; freezes a proposal revision |
| POST | `/crm/deals/{id}/accept` | Customer owner. `{revision_id}` must match the current proposal |
| POST | `/crm/deals/{id}/activate` | Issuer. Empty JSON body; accepted proposal creates one base plan and closes won atomically |
| POST | `/crm/deals/{id}/lose` | Issuer. `{reason}` required; accepted deals cannot silently close lost |
| GET | `/crm/deals/{id}/revisions` | Actual owner. Immutable published scope/rate/date snapshots |
| GET | `/projects/{project_id}/billing-plan` | Actual owner. `{plan: null|record, ...defaults}` |
| GET | `/projects/{project_id}/finance-events` | Actual owner. Durable commercial mutation events; no ordinary global audit access |
| GET | `/crm/issuer-operators` | Global admin. Assignment metadata only; no customer financial data |
| PUT | `/crm/issuer-operators/{user_id}` | Global admin. `{active: boolean, reason}`; target must be an active admin to assign; durable audit event |

CRM lists use indexed record-ID order with `page_size` 1-50 and `cursor`; response `{items, next_cursor}`. There is deliberately no misleading total from a capped workspace scan.

Create requires `name`, `scope`, `currency: "INR"`, `billing_method: "fixed"|"hourly"` and positive `amount_minor` (fixed price or hourly cap, max 1,000,000,000,000 paise). Hourly terms also require positive `hourly_rate_minor` and `planned_minutes`. Optional `start_date`, `end_date`, `expected_close_date` use real calendar dates; `stage` can initially be `qualified`, `discovery` or `negotiation`. IDs, ownership and closed stages cannot be set in the body.

All action POSTs require `If-Match` and an `Idempotency-Key` of 1-120 letters, digits, underscores or hyphens. Replaying a committed key/body for the same actor/deal/action returns its original result; changing the body returns `409 IDEMPOTENCY_CONFLICT`. Mutable record versions are mandatory (`428` missing, `412` stale). Any saved edit invalidates the current proposal/acceptance without altering historic revisions. Closed deals cannot be edited. A project has one base plan; additional accepted `deal_type: "change_order"` deals increase its cap without resetting scheduled/billed amounts. They must preserve currency, billing method and hourly rate. The default type is `"base"`. `POST /crm/deals/{id}/reject` with `{reason}` allows a customer owner to request revision of an unaccepted proposal without changing its published snapshot.

Creating the first deal marks its project `finance_retained`; DELETE returns `409 FINANCE_RETENTION_REQUIRED`. Archive the project with its ordinary status update instead. Existing project deletion behavior is unchanged when there is no commercial history.

Owner invitations are revalidated against their original inviting owner's active membership/account at acceptance; a revoked grant returns `409 INVITE_AUTHORITY_REVOKED`. A non-owner SGS admin cannot resend an owner invitation. One platform admin may assign issuer authority, including to themselves, with an audited reason; this never grants actual workspace membership.

## Project finance

Open `/workspace/billing/?client={client_id}&project={project_id}` from the project or CRM page. All finance endpoints are under `/api/v1/projects/{project_id}/finance`. Every read requires **actual active workspace ownership**. SGS global admin is not a bypass. Mutations require the assigned SGS issuer who also owns that workspace, except customer approval actions. All responses are `Cache-Control: no-store`; list responses are `{items,next_cursor}`.

All command POSTs and profile PUT require `Idempotency-Key`. PATCH, profile PUT and record action POSTs require the current `If-Match: "vN"` (`"v0"` for a missing profile); stale versions return 412. Keys are actor/project/operation scoped. Replays revalidate current authority and return the committed result. Errors never turn a failed notification or unconfigured integration into success.

| Method | Suffix | Body / behavior |
| --- | --- | --- |
| GET/PUT | `/profile` | Workspace-shared billing profile: `customer_name`, `customer_address`, `customer_state_code`, optional `customer_gstin`, `issuer_name`, `issuer_address`, `issuer_state_code`, `issuer_gstin`, `bank_details`, six-digit `sac_code`, `gst_rate_bps`, `legal_approved`, `legal_approval_reference` |
| GET | `/summary` | INR contract/invoiced/credited/paid/outstanding/unallocated/refunded/overdue totals, aging buckets, resource deadline/capacity risks |
| GET/POST | `/resources` | Create `{name,role,planned_minutes,weekly_capacity_minutes,start_date,end_date}` |
| GET/PATCH | `/resources/{id}` | View/edit assignment estimates and dates; accepted commercial rate is not editable here |
| GET/POST | `/time-entries` | Create `{resource_id,work_date,minutes,description}`; work must be within assignment dates, not in the future |
| GET/PATCH | `/time-entries/{id}` | Submitted/approved/billed entries are locked |
| GET/POST | `/time-statements` | Submit `{entry_ids}` (1-20), snapshots entry versions and locks them |
| POST | `/time-statements/{id}/approve` or `/reject` | Customer owner only; `{}` or `{reason}`. Rejected time is unlocked for correction |
| GET/POST | `/billing-items` | Fixed schedule `{title,amount_minor,due_date,requires_acceptance}`; total reservations cannot exceed accepted cap |
| POST | `/billing-items/{id}/accept` | Customer owner; `{}` |
| POST | `/billing-items/{id}/cancel` | Issuer; `{reason}`. Unbilled only; preserves record and releases scheduled cap |
| GET | `/monthly-candidates?month=YYYY-MM` | Eligible approved/unbilled sources through month end, including carryover; `{month,cutoff,source_type,items}` |
| GET/POST | `/invoices` | Draft `{source_type:"billing_item"\|"time_entry",source_ids,issue_date,billing_month?}` with 1-20 sources. Monthly date cannot precede month end |
| GET/PATCH | `/invoices/{id}` | Read with settlement/overdue status; only draft `issue_date` can be edited |
| POST | `/invoices/{id}/issue` | `{}`; legal/deployment gates; source revalidation/claim, cap and unique fiscal number in one transaction; due in 30 days |
| POST | `/invoices/{id}/notify` | `{}`; durable owner notification, visible delivery state. 503 on failure retains issued invoice; retry safely |
| POST | `/invoices/{id}/void` | `{reason}`; separately gated, unpaid/uncredited only; no source release or number reuse |
| GET | `/invoices/{id}/document` | Original archived PDF; voided invoices remain downloadable as historical originals with `document_state:"void"` |
| GET/POST | `/payments` | Manual receipt `{amount_minor,received_date,reference,invoice_id?}`; excess becomes unallocated credit |
| POST | `/payments/{id}/allocate` | `{invoice_id,amount_minor}` from available unallocated credit; prevents overpayment |
| POST | `/payments/{id}/reverse` | `{reason}` reverses allocations with retained history; refunded receipts require separate correcting entries |
| GET/POST | `/credit-notes` | `{invoice_id,net_minor,reason}`; cumulative tax rounding, cannot exceed remaining unpaid balance |
| GET | `/credit-notes/{id}/document` | Archived correction PDF with original invoice reference |
| GET/POST | `/refunds` | `{payment_id,amount_minor,reason}`; cannot exceed unallocated receipt credit |

Every listed collection also supports `GET /{kind}/{id}`. Money is integer paise, INR only, bounded to 1,000,000,000,000 per net amount. Hourly money and GST use integer half-up arithmetic. Intra-state tax splits into CGST/SGST; interstate uses IGST. Allowed reviewed rates are 0/5/12/18/28%. GSTIN format validation is **not** registration verification or tax advice.

Documents return `{filename,content_type,content_base64,checksum,...metadata}` for authenticated Blob download. Private immutable archive records are limited to 600 KB of PDF binary (below Firestore's document limit after base64). Renderer v1 embeds a Latin-script font and explicitly rejects unsupported characters before issuance; it does not silently omit legal text. Extend and approve the font/shaping pipeline before using other scripts.

Monthly billing is an **explicit issuer review workflow**, not automatic charging: select eligible sources for a closed month, batch at most 20 per draft, review, then issue. GitHub activity never creates billable time, changes agreed prices, or issues invoices.

`POST /api/v1/crm/finance-worker/retry` is service-only, not user-session authenticated. Body `{project_id,cursor?}` processes one page of at most 10 durable notification jobs and returns `{results,next_cursor}`. Follow cursors to exhaustion each scheduled run. It uses the same strictly verified OIDC audience/service account as the [GitHub worker](github-crm.md), and revalidates the original issuer's actual membership and entitlement. Expired leases recover; sent jobs skip; failed deliveries back off at least a minute, maximum 10 automatic attempts. Individual job errors appear in results and sanitized logs. An explicit authorized Notify command can start a fresh reviewed retry cycle; lifetime attempt count remains recorded.

GitHub endpoints, external permissions, webhook and reconciliation contracts are documented in [GitHub CRM setup](github-crm.md).

## Products, catalog and launch links

| Method | Path | Notes |
| --- | --- | --- |
| GET/POST | `/products` | `client_id?`, `project_id?`, `status?`. POST `{client_id, kind, name, slug?, summary?, launch_url?, store_urls?, status?, visibility?, order?, project_id?}`. `https://` only. `visibility: public` is SGS-admin only. Slug clash → `409 SLUG_TAKEN` with a suggestion |
| GET/PATCH/DELETE | `/products/{id}` | admin to change |
| GET | `/products/by-slug/{slug}` | Public products for anyone; others need membership (`401`/`403`) |
| POST | `/products/{id}/launch-token` | Any member. `{token, url, path, expires_in: 60}`; single use |
| GET | `/products/{id}/launches` | admin. Last 30 days by source |
| GET | `/catalog` | Public. Public, non-retired products; no tenant ids; cached 5 min |
| GET | `/go/{slug}` | Public products redirect at once. Client products need `?t=<launch token>`, otherwise `302 /workspace/launch/?slug=` (signs in and returns with a token). Records a launch event and adds `utm_source=sgsai_hub&utm_medium=web\|android\|ios\|link`. Unknown → branded 404, retired → `410` page |

## Assets (Cloud Storage)

| Method | Path | Notes |
| --- | --- | --- |
| POST | `/assets/upload-url` | admin of the owner's workspace. `{owner: {type: client\|project\|product, id}, purpose: logo\|cover\|icon\|deliverable\|media, kind: image\|video\|document, filename, content_type, size_bytes, alt_text?}` → `{asset, upload: {url, method: PUT, headers}}`. Limits: images 10 MB (png, jpeg, webp, gif), video 500 MB (mp4, webm, mov), documents 25 MB (pdf, txt, csv, docx, xlsx, pptx). Logos, covers and icons need `alt_text` |
| POST | `/assets/{id}/confirm` | Verifies size and type in storage, then links logo/cover/icon. `409 OBJECT_MISSING` / `OBJECT_MISMATCH` |
| GET | `/assets?owner_type=&owner_id=&purpose=` | viewer |
| GET | `/assets/{id}/url` | viewer. Signed read URL valid 1 hour (deliverables download as attachments) |
| DELETE | `/assets/{id}` | admin |

## Audit

`GET /audit?client_id=&action=` — workspace owners (or SGS admins without `client_id`). 90-day retention. Entries never contain secrets.
