# API reference

The Node API (`src/server/`) serves the website and the mobile app (ADR-002). Nginx proxies `/api/v1/*`, `/go/*`, `/api/readyz`, the legacy `/api/contact|config|analytics` endpoints and the two `/.well-known/` association files to it.

## Conventions

- JSON in and out. `/api/v1` errors use `{ "error": { "code", "message", "details": [{ "field", "message" }], "request_id" } }`; wrong methods return `405` with `Allow`.
- Authentication: `Authorization: Bearer <access_token>` (1 hour). Refresh tokens rotate on every use and are single-use; presenting a spent one revokes that session family.
  - Web (default): the refresh token is an `HttpOnly; Secure; SameSite=Strict` cookie scoped to `/api/v1/auth`.
  - Mobile: send `X-Client: mobile` and `X-Client-Platform: android|ios`. Sign-in responses include `refresh_token`; refresh with `POST /auth/token/refresh {"refresh_token"}`; sign out with `POST /auth/logout {"refresh_token"}`.
- Roles: global `role` is `user` or `admin` (SGS staff). Workspace roles are `viewer < member < admin < owner`; SGS admins act as owners everywhere. Requests for another tenant's data return `404`, never the data.
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
