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

Memberships are a top-level collection (rather than the `clients/{id}/members` subcollection sketched in ADR-002) so "my workspaces" is a plain equality query with no collection-group index.

## Queries and indexes

Queries use equality filters only and are served by Firestore's single-field index merging; [config/firestore/firestore.indexes.json](../config/firestore/firestore.indexes.json) adds composites for the hottest multi-field lookups and exempts large fields from indexing. Sorting, free-text search (`q`) and paging happen in the API after loading at most 1,000–5,000 documents for one workspace scope. That is deliberate for the expected scale (tens of workspaces, hundreds of projects); revisit with cursor pagination or Postgres (API-19) before a workspace exceeds a few thousand documents.

## Cloud Storage layout

```text
gs://sgsai-media-{env}/pending/clients/...                                                   uploads until confirmed; lifecycle deletes after 1 day
gs://sgsai-media-{env}/clients/{client_id}/{image|video|document}/{asset_id}-{slug}.{ext}   private, signed URLs only
gs://sgsai-public-assets-{env}/products/{product_id}/{object}                               public icons of public products
```

Object names never contain raw user input: the base name is slugified and the extension comes from the validated content type.
