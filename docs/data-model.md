# Data model

Metadata lives in Firestore (native mode, project `home-509818`); binaries live in Cloud Storage (ADR-002). The API is the only reader and writer: [config/firestore/firestore.rules](../config/firestore/firestore.rules) denies all client SDK access. `src/server/db.mjs` is the only data access layer, which keeps a later move to PostgreSQL contained.

Conventions: snake_case fields, ISO-8601 strings for timestamps, numeric `expires_at` (ms) for expiry checks. Any document with a numeric `expires_at` also gets an `expire_at` Timestamp, which drives the Firestore TTL policy and is never returned by the API.

| Collection | Document id | Key fields | TTL (`expire_at`) |
| --- | --- | --- | --- |
| `users` | `usr_<uuid>` | `email` (lowercase, unique), `full_name`, `role` user\|admin, `status` active\|disabled\|deleted, `password_hash` (scrypt), `google_sub`, `apple_sub`, `mfa {enabled, secret_enc (AES-256-GCM), recovery_hashes[], last_step, failures, locked_until}`, `default_client_id` | — |
| `user_sessions` | `ses_<uuid>` | One per sign-in ("device"): `user_id`, `client` web\|android\|ios, `user_agent`, `ip_hash`, `amr[]`, `created_at`, `last_seen_at` | 90 days |
| `sessions` | SHA-256(access token) | `user_id`, `session_id`, `client` | 1 hour |
| `refresh_tokens` | SHA-256(refresh token) | `user_id`, `session_id`, `used_at` (kept to detect reuse) | 30 days |
| `email_verifications`, `password_resets`, `mfa_challenges`, `launch_tokens` | SHA-256(token) | single-use records | 24 h, 1 h, 5 min, 60 s |
| `clients` | `cli_<uuid>` | `name`, `slug` (unique), `primary_sector` business\|education, `status` prospect\|active\|paused\|closed, `contact {email, phone, website}`, `branding {primary_color, logo_asset_id}` | — |
| `memberships` | `<client_id>__<user_id>` | `client_id`, `user_id`, `role` viewer\|member\|admin\|owner, `status` active, `invited_by`, `joined_at` | — |
| `invites` | `inv_<uuid>` | `client_id`, `email`, `role`, `token_hash`, `accepted_at`, `accepted_by` | 7 days |
| `projects` | `prj_<uuid>` | `client_id`, `name`, `sector`, `status`, `summary`, `tags[]`, `start_date`, `end_date`, `sector_profile`, `milestones[{title, due, done}]` (≤ 20), `cover_asset_id`, `version` (ETag), `deleted_at` | 30 days after soft delete |
| `products` | `prd_<uuid>` | `client_id`, `project_id`, `kind` pwa\|web\|android\|ios\|service, `name`, `slug` (globally unique, used by `/go/`), `launch_url`, `store_urls`, `status` planned\|beta\|live\|retired, `visibility` client\|public, `icon_asset_id`, `public_icon_url`, `public_icon_object`, `order` | — |
| `assets` | `ast_<uuid>` | `client_id`, `owner_type`, `owner_id`, `purpose`, `kind`, `content_type`, `size_bytes`, `gcs_bucket`, `gcs_object`, `gcs_pending_object` (upload target until confirmed), `status` pending\|ready, `md5`, `alt_text` | 24 h while pending |
| `launch_events` | `lev_<uuid>` | `product_id`, `client_id`, `user_id`, `source` web\|android\|ios\|link, `ts` | 180 days |
| `audit_log` | `aud_<uuid>` | `actor_id`, `action`, `target_type`, `target_id`, `client_id`, `ip_hash`, `request_id`, `diff` (secret-like keys dropped), `ts` | 90 days |
| `issuer_operators` | user ID | `id`, `user_id`, `active`, `updated_by`, `updated_at`; assignment alone does not grant tenant access | None |
| `issuer_operator_events` | `ioe_<uuid>` | Global restricted assignment audit: actor, target user, active/revoked, reason, request ID, timestamp | None |
| `deals` | `dea_<uuid>` | `client_id`, `project_id`, project name snapshot, scope, stage/probability, INR `amount_minor` (price/cap), method fixed/hourly, rate/minutes, dates, version, current/accepted revision, active plan | None |
| `commercial_revisions` | `<deal_id>__r<sequence>` | Immutable deal terms, resource estimate, dates, currency/billing defaults, publisher/time; customer acceptance stored separately | None |
| `commercial_acceptances` | revision ID | `client_id`, `project_id`, `deal_id`, `revision_id`, `accepted_by`, `accepted_at` | None |
| `billing_plans` | `<project_id>__base` | One accepted base plan/project, commercial revision, method/amount/rate/minutes/dates, INR, month_end, net 30, tax unconfigured | None |
| `financial_events` | `fev_<uuid>` | `client_id`, `project_id`, actor/action/target ID/version, request ID, UTC timestamp; committed atomically with commercial mutations | None |
| `idempotency_records` | SHA-256(actor/deal/action/key) | `client_id`, `project_id`, actor, request hash, immutable committed result/time | None |

Memberships are a top-level collection (rather than the `clients/{id}/members` subcollection sketched in ADR-002) so "my workspaces" is a plain equality query with no collection-group index.

CRM financial data is accessible only through actual owner membership, without the global administrator bypass. Issuer authority additionally requires an active `issuer_operators` record and global admin role. Operational issuer assignment events contain no customer amounts. Finance events are not copied into the existing broadly accessible `audit_log`.

The first deal atomically sets `projects.finance_retained = true`, clears expiry, and increments the project version. Such projects cannot enter the 30-day delete/TTL path; archive them instead. No financial TTLs are configured. Production retention/legal holds must be approved before real invoicing. Issuance is implemented but disabled by default; it requires both deployment authorization and a reviewed legal/tax profile.

`transactDocs()` reads all declared documents before a synchronous bounded mutation callback; write references must be declared and unique. Firestore transactions revalidate user, actual membership, issuer entitlement, project, deal version and command replay. The memory implementation commits without an async interleaving point and stages writes before changing any document. Revisions and acceptances are immutable; plan activation, idempotency result and durable financial event share one transaction.

## Queries and indexes

### Project finance and delivery records

All financial collection records below carry `id`, `client_id`, `project_id` and versions/timestamps unless noted. They have no TTL. Direct browser Firestore access remains denied.

| Collection | Purpose / invariants |
| --- | --- |
| `billing_profiles` | Workspace-shared reviewed issuer/customer/GST/bank configuration; issued documents snapshot it |
| `crm_resources` | Role, planned effort/capacity, assignment dates; estimates are not billable time |
| `billing_items` | Fixed milestones reserve accepted cap; acceptance/cancellation/billing state retained |
| `time_entries`, `time_statements` | Accepted-rate snapshots, submitted entry-version claims, customer approval/rejection; locked approved work |
| `invoices` | Draft/issued/void states, legal/source snapshots, number, settlement totals; sources claimed atomically with numbering |
| `invoice_counters` | Global issuer fiscal invoice sequences and separate credit-note sequence; never reuse an issued number |
| `payments` | Confirmed/reversed manual receipts, allocation history, unallocated/refunded balance |
| `credit_notes`, `refunds` | Immutable correction records; cumulative rounded taxes and available-credit caps |
| `finance_documents` | Private immutable base64 PDFs, SHA-256 checksum and renderer version; never ordinary shared assets |
| `finance_jobs` | Durable notification intent, requesting actor, states, attempts, backoff and expiring exclusive lease |

`billing_plans` retain scheduled/billed totals while accepted additive change orders increase the contract cap and extend the deadline. Original deal revisions/acceptances and financial events preserve evidence; hourly-rate/method/currency changes are rejected rather than repricing old work. No automatic charge or general-ledger posting occurs.

`queryPage({documentIdOrder:true})` supports legacy membership records without an `id` data field. Owner notification discovery queries only that workspace's active owner memberships, using document IDs as cursors, then checks active customer users; it does not scan every platform user.

GitHub binding/cache/command/inbox records and external-data retention are described in [GitHub CRM setup](github-crm.md). Financial and GitHub histories are distinct: engineering events cannot change financial balances.

Queries use equality filters only and are served by Firestore's single-field index merging; [config/firestore/firestore.indexes.json](../config/firestore/firestore.indexes.json) adds composites for the hottest multi-field lookups and exempts large fields from indexing. Sorting, free-text search (`q`) and paging happen in the API after loading at most 1,000–5,000 documents for one workspace scope. That is deliberate for the expected scale (tens of workspaces, hundreds of projects); revisit with cursor pagination or Postgres (API-19) before a workspace exceeds a few thousand documents.

Exception: CRM deal/revision/event lists use `queryPage()` with equality filters, ascending immutable `id`, `startAfter` and a page-size-plus-one fetch. They return a cursor, never totals computed from a truncated scan. Composite indexes cover client/project/stage filters. Deploy the new indexes before enabling CRM in a deployed environment.

## Cloud Storage layout

```text
gs://sgsai-media-{env}/pending/clients/...                                                   uploads until confirmed; lifecycle deletes after 1 day
gs://sgsai-media-{env}/clients/{client_id}/{image|video|document}/{asset_id}-{slug}.{ext}   private, signed URLs only
gs://sgsai-public-assets-{env}/products/{product_id}/{object}                               public icons of public products
```

Object names never contain raw user input: the base name is slugified and the extension comes from the validated content type.
