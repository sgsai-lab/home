# OneAI Client Platform: project plan

Status: **accepted** (2026-10-27); issues filed across all four repos. Owner: product/PM. Tracked on the [SGSAI OneAI](https://github.com/orgs/sgsai-lab/projects/1) board.

This plan turns the SGS AI website from a marketing site with a half-wired account area into the hub for the **business** and **education** projects SGS delivers for clients, and defines the mobile app that launches client services. Issues are filed across `home`, `infrastructure`, `mobile-app` and `backend-api`; this document is the single narrative behind them.

## 1. Problem

- SGS AI delivers projects for clients in two sectors (business, education). Each project produces one or more products/services, most of them PWAs hosted by or for the client.
- Today the website has no concept of a client, a project owned by a client, or a product that belongs to a project. `/projects/` is a per-user stub, `/products/` is a hard-coded array, `/admin/` only manages users.
- The account area is ahead of the API: sign-up, email/password sign-in, password reset, email verification, MFA, admin user management and project CRUD all return `404` in production (verified 2026-10-27 against `www.sgsaitechnology.com`). Visitors can reach every one of these flows from the public navigation.
- A mobile app is planned but has no defined concept (`mobile-app#1` is still open). The business need is clear: a client's users should open the SGS app, see the projects and services they started with SGS, and tap through to the associated client PWA.

## 2. Outcomes (how we know it worked)

| Outcome | Metric | Target |
| --- | --- | --- |
| Account flows work | 5xx/404 rate on `/api/v1/auth/*` from the web UI | 0 unexpected 404s; sign-up → verified → signed-in completion ≥ 60 % |
| Clients self-serve | Clients with ≥ 1 active member who signed in within 30 days | ≥ 80 % of onboarded clients |
| Launcher is used | Launch events via `/go/{slug}` (web + mobile) per active client per week | ≥ 3 |
| Content is managed, not coded | Products on `/products/` sourced from Firestore | 100 % |
| Quality held | Lighthouse (performance, a11y, best practices, SEO) on every public page | ≥ 90, enforced in CI |

## 3. Users and jobs

| Persona | Job to be done |
| --- | --- |
| **SGS admin** (role `admin`) | Create a client workspace, invite the client's people, record the project, publish its products/services, upload logos/media. |
| **Client owner/admin** (membership role `owner`/`admin`) | See the status of every project started with SGS, manage who on their side has access, open the delivered apps. |
| **Client member** (`member`/`viewer`) | Open the apps and services their organisation has; read project updates. Business example: an operations lead opening the ordering PWA. Education example: a teacher opening the learning portal. |
| **Visitor** | Understand what SGS does and see public products; contact SGS. |

## 4. Scope

### In (this plan)
1. Fix the broken account flows and ship the missing API on the existing Node + Firestore stack.
2. Client workspaces: clients, memberships, invites, role-based access.
3. Catalog: projects, products and services per client, with sector-specific fields, public/private visibility, and launch links (`/go/{slug}`).
4. Media: metadata in Firestore, binaries in GCS behind signed URLs.
5. Mobile hub (Flutter): sign in, pick workspace, see projects and apps, tap to launch the client PWA, deep links from `/go/*`.
6. Website as installable PWA for the signed-in hub.
7. Hardening: audit log, rate limits, observability, Lighthouse in CI, docs.

### Out (deferred, tracked as notes on the epics)
- Billing/invoicing, contracts, e-signature.
- Hosting the client PWAs themselves (we link to them; we do not host them).
- Chat/messaging, ticketing.
- Postgres migration (see ADR-002 below): design for it, do not build it yet.
- Native in-app rendering of client apps (we open them in the system browser / Custom Tabs / SFSafariViewController).

## 5. Architecture decisions

### ADR-002 (accepted 2026-10-27): Firestore first; `home` owns `/api/v1`
Full text with sequence diagrams: [ADR-002](../adr/0002-firestore-first-data-platform.md). Summary of the nine decisions:

1. Hub users are **client staff only**; students and a client's customers never get hub accounts.
2. Sector is **per project**; a client carries `primary_sector` for display and defaults.
3. Mobile authenticates with **`home` tokens** through `/api/v1/auth/*` (Google Sign-In on device for the ID token; no Firebase Auth SDK).
4. **`home`'s Node API is the system of record for `/api/v1`** for six weeks; `backend-api` pauses feature work (API-07…16) and keeps CI/deploy; Cloud SQL (`infrastructure#8`) paused.
5. **Firestore native mode** in the Cloud Run GCP project, API-only access, Rules deny client SDKs.
6. **Private media bucket + signed URLs; public product icons copied to `sgsai-public-assets-{env}`.**
7. `/go/{slug}` for client-visibility products **requires sign-in**; mobile uses a single-use 60 s launch token.
8. Mobile: internal build Week 7 (Dec 2026); **private beta Q1 2027** as published on `/products/`.
9. The founder approves and administers; repo owners are informed through linked issues.

### Data model (Firestore, metadata only)

```text
users/{userId}                      existing + default_client_id
clients/{clientId}                  name, slug, primary_sector: business|education (display/default only), status: prospect|active|paused|closed,
                                    branding{logo_asset_id, primary_color}, contact{email, phone, website},
                                    created_by, created_at, updated_at
clients/{clientId}/members/{userId} role: owner|admin|member|viewer, status: invited|active|removed,
                                    invited_by, joined_at           (collection-group query "memberships" for "my clients")
invites/{inviteId}                  client_id, email, role, token_hash, expires_at (TTL), accepted_at
projects/{projectId}                client_id, name, slug, sector: business|education (authoritative), status: draft|discovery|in_progress|on_hold|delivered|archived,
                                    summary, start_date, end_date, tags[], owner_user_id, cover_asset_id,
                                    sector_profile{ business: {engagement_type, department} | education: {institution_type, programme, cohort, academic_year} },
                                    milestones[{title, due, done}] (≤ 20), deleted_at (soft delete, 30 days)
products/{productId}                client_id, project_id?, kind: pwa|web|android|ios|service, name, slug (global unique),
                                    summary, launch_url, store_urls{android, ios}, icon_asset_id,
                                    status: planned|beta|live|retired, visibility: client|public, order
assets/{assetId}                    owner{type: client|project|product, id}, kind: image|video|document|other,
                                    gcs_bucket, gcs_object, content_type, size_bytes, sha256,
                                    status: pending|ready|deleted, created_by, created_at
launch_events/{eventId}             product_id, client_id, user_id?, source: web|android|ios|link, ts (TTL 180 days)
audit_log/{eventId}                 actor_id, action, target{type,id}, client_id?, ts, request_id
sessions, refresh_tokens            existing
```

Rules of the model:
- Every tenant-owned document carries `client_id`; the API authorises by `clients/{client_id}/members/{userId}` with role ≥ required. No cross-client queries except for `admin`.
- Binary content never goes in Firestore; `assets` holds metadata and the API issues V4 signed URLs for upload (PUT, 15 min) and read (GET, 1 h). Public product icons may be served from a public bucket prefix.
- GCS layout: `gs://sgsai-media-{env}/clients/{clientId}/{kind}/{assetId}-{safe-filename}`. Lifecycle: delete `pending` objects after 1 day, keep `ready`; versioning on; uniform bucket-level access; CORS for the site origin.
- Launch links: `GET /go/{slug}` records a `launch_event` and `302`s to `launch_url` with `utm_source=sgsai_hub`. This is **not** under `/api/v1`, so it needs its own Nginx `location` and must be allowed by the mobile App Links / Universal Links files served from `/.well-known/`.

### API surface (new or completed in `home`)

| Area | Endpoints |
| --- | --- |
| Auth (complete the contract) | `POST /auth/signup`, `POST /auth/login`, `POST /auth/verify-email`, `POST /auth/verify-email/resend`, `POST /auth/password/forgot|reset|change|set`, `GET /auth/mfa`, `POST /auth/mfa/totp/setup|confirm`, `POST /auth/mfa/verify`, `GET /auth/mfa/recovery-codes`, `GET /auth/sessions`, `DELETE /auth/sessions/{id}` |
| Users (admin) | `GET /users`, `PATCH /users/{id}`, `DELETE /users/{id}` |
| Clients | `GET/POST /clients`, `GET/PATCH /clients/{id}`, `GET/POST /clients/{id}/members`, `PATCH/DELETE /clients/{id}/members/{userId}`, `POST /clients/{id}/invites`, `POST /invites/accept` |
| Projects | `GET/POST /projects?client_id=`, `GET/PATCH/DELETE /projects/{id}`, `POST /projects/{id}/restore` (ETag / `If-Match` as the UI already expects) |
| Products | `GET/POST /products?client_id=`, `GET/PATCH/DELETE /products/{id}`, `GET /catalog` (public, `visibility=public`), `GET /go/{slug}` |
| Assets | `POST /assets/upload-url`, `POST /assets/{id}/confirm`, `GET /assets/{id}/url`, `DELETE /assets/{id}` |

All errors use `{ "error": { "code", "message", "details" } }`; all mutations are rate limited per user and written to `audit_log`.

## 6. Phases and milestones

Weeks are the existing sprint convention (`week-N` labels, `Week N - …` milestones). Weeks 1–2 are done. Milestones and `week-3`…`week-8` labels exist in all four repos.

| Phase | Milestone | Goal | Exit criteria |
| --- | --- | --- | --- |
| 0 · Stabilise | **Week 3 - Auth & Core APIs** (exists in `backend-api`; add to others) | No public flow returns 404; ADR-002 accepted | WEB-12…WEB-21 closed; ADR-002 merged; CSP-clean console on every page |
| 1 · Workspaces | **Week 4 - Client Workspaces** | Admin can create a client and invite people; invitee signs in and sees their workspace | WEB-24…WEB-27, INF-13 closed |
| 2 · Catalog | **Week 5 - Catalog & Launch Links** | Projects/products/services per client; `/products/` driven by data; `/go/{slug}` live | WEB-29…WEB-32 closed; first real client onboarded |
| 3 · Media | **Week 6 - Media & Storage** | Logos, covers, icons, documents stored in GCS via signed URLs | INF-12, WEB-34, WEB-35 closed |
| 4 · Mobile hub | **Week 7 - Mobile Hub** | Flutter app: sign in → workspace → launch PWA; deep links | APP-11…APP-14, WEB-40 closed; internal build distributed (`mobile-app#10`) |
| 5 · Harden & launch | **Week 8 - Hardening & Launch** | Audit log, rate limits, alerts, Lighthouse in CI, docs; website PWA | WEB-36, WEB-37, WEB-39, APP-15/16, API-18 closed |

### Now / Next / Later

- **Now:** WEB-12 (auth 404s), WEB-13 (projects stub), WEB-22 (ADR-002), WEB-16 (CSP-blocked fonts/icons), INF-13 (Firestore TTL/indexes).
- **Next:** workspaces (WEB-24…27), catalog (WEB-29…31), GCS bucket (INF-12), mobile brief (APP-11).
- **Later:** mobile screens, website PWA, push notifications, Postgres spike (API-19).

## 7. Prioritisation (RICE, relative)

| Item | Reach | Impact | Confidence | Effort (days) | Score |
| --- | --- | --- | --- | --- | --- |
| WEB-12 fix auth 404s | every new user | 3 | 0.9 | 3 | **high** |
| WEB-22 ADR-002 data platform | all teams | 3 | 0.8 | 0.5 | **high** |
| WEB-24/25 client workspaces | all clients | 3 | 0.8 | 4 | **high** |
| WEB-29/30 projects + products + `/go` | all clients | 3 | 0.8 | 4 | **high** |
| WEB-16 CSP fonts/icons | every visitor | 2 | 1.0 | 1 | high |
| WEB-34 assets via GCS | admins | 2 | 0.7 | 3 | medium |
| APP-12/13 mobile hub screens | client members | 3 | 0.6 | 6 | medium |
| WEB-36 website PWA | client members | 1 | 0.7 | 2 | medium |
| APP-17 push notifications | client members | 1 | 0.5 | 3 | low (stretch) |

## 8. Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Two backends (`home` Node, `backend-api` FastAPI) diverge | ADR-002; shared OpenAPI contract (`backend-api#18`); identical error envelope; contract tests in `home` |
| In-memory fallback hides Firestore outages and breaks sessions across Cloud Run instances | WEB-20 makes the fallback opt-in by env var and surfaces a `/readyz` check; alerts via `infrastructure#10` |
| CSP blocks new origins (GCS signed URLs, client PWAs) | Only `img-src`/`media-src` for `storage.googleapis.com`; launches are top-level navigations, not embeds |
| Firestore cost from list queries | Page size ≤ 50, composite indexes, denormalised `members` collection group, TTL on events |
| Deep links fail on iOS/Android | `/.well-known/assetlinks.json` and `apple-app-site-association` served with correct content types; verified in `mobile-app#9` signing work |
| Education data may include minors' data | Store only staff accounts in MVP; no student PII; privacy notice update in WEB-39 |
| Scope creep (hosting client apps, billing) | Explicit "Out" list; epics carry a deferred list |

## 9. Issue map

Prefixes continue the existing numbering: `WEB-12+` (`home`), `INF-12+` (`infrastructure`), `APP-11+` (`mobile-app`), `API-18+` (`backend-api`). Full drafts live with the issues; parent/sub-issue relationships are recorded with GitHub sub-issues and "Blocked by" dependencies rather than checklists.

| ID | Repo | Title | Type | Priority | Week |
| --- | --- | --- | --- | --- | --- |
| [WEB-12](https://github.com/sgsai-lab/home/issues/45) | home | Email/password sign-up, sign-in, password reset and email verification return 404 in production | bug | P0 | 3 |
| [WEB-13](https://github.com/sgsai-lab/home/issues/46) | home | Projects page cannot create, edit or delete: `/api/v1/projects` is a stub | bug | P0 | 3 |
| [WEB-14](https://github.com/sgsai-lab/home/issues/47) | home | Admin users console calls a non-existent `/api/v1/users` | bug | P1 | 3 |
| [WEB-15](https://github.com/sgsai-lab/home/issues/48) | home | Account security panel: password change, MFA 404; session list and revoke are fake | bug, security | P1 | 3 |
| [WEB-16](https://github.com/sgsai-lab/home/issues/49) | home | CSP blocks Google Fonts, Font Awesome and Plausible on every page | bug | P1 | 3 |
| [WEB-17](https://github.com/sgsai-lab/home/issues/50) | home | Sitemap, analytics allowlist, Lighthouse URLs and robots.txt out of sync with routes | bug | P2 | 3 |
| [WEB-18](https://github.com/sgsai-lab/home/issues/51) | home | Cache-bust version drift (`?v=7` vs `?v=8`) | bug | P2 | 3 |
| [WEB-19](https://github.com/sgsai-lab/home/issues/52) | home | Navigation links omit the trailing slash and 301 on every click | bug | P2 | 3 |
| [WEB-20](https://github.com/sgsai-lab/home/issues/53) | home | API: inconsistent error envelope, unauthenticated `/auth/mfa`, silent in-memory fallback | bug | P2 | 3 |
| [WEB-21](https://github.com/sgsai-lab/home/issues/54) | home | Re-enable Lighthouse budgets in CI | chore | P2 | 3 |
| [WEB-22](https://github.com/sgsai-lab/home/issues/55) | home | ADR-002: Firestore-first data platform and `/api/v1` ownership | decision | P0 | 3 |
| [WEB-23](https://github.com/sgsai-lab/home/issues/56) | home | Epic: Client workspaces (business & education) | feature | P1 | 4 |
| [WEB-24](https://github.com/sgsai-lab/home/issues/57) | home | Firestore data model, indexes and access-control helpers for workspaces | feature | P1 | 4 |
| [WEB-25](https://github.com/sgsai-lab/home/issues/58) | home | Clients, memberships and invites API | feature | P1 | 4 |
| [WEB-26](https://github.com/sgsai-lab/home/issues/59) | home | Admin console: manage clients, members and invites | feature | P1 | 4 |
| [WEB-27](https://github.com/sgsai-lab/home/issues/60) | home | `/workspace/` page: client switcher, projects and apps for signed-in members | feature | P1 | 4 |
| [WEB-28](https://github.com/sgsai-lab/home/issues/61) | home | Epic: Projects, products & services catalog | feature | P1 | 5 |
| [WEB-29](https://github.com/sgsai-lab/home/issues/62) | home | Projects API scoped to client membership (replaces stub; ETag, soft delete, restore) | feature | P1 | 5 |
| [WEB-30](https://github.com/sgsai-lab/home/issues/63) | home | Products & services API and `/go/{slug}` launch links | feature | P1 | 5 |
| [WEB-31](https://github.com/sgsai-lab/home/issues/64) | home | `/products/` driven by the public catalog instead of a hard-coded array | content | P2 | 5 |
| [WEB-32](https://github.com/sgsai-lab/home/issues/65) | home | Project detail page: milestones, team, deliverables, linked apps | feature | P2 | 5 |
| [WEB-33](https://github.com/sgsai-lab/home/issues/66) | home | Epic: Media and assets on GCS | feature | P1 | 6 |
| [WEB-34](https://github.com/sgsai-lab/home/issues/67) | home | Assets API: signed upload/read URLs with Firestore metadata | feature | P1 | 6 |
| [WEB-35](https://github.com/sgsai-lab/home/issues/68) | home | Upload and display client logos, project covers and product icons | feature | P2 | 6 |
| [WEB-36](https://github.com/sgsai-lab/home/issues/69) | home | Installable PWA for the signed-in hub (manifest scope, service worker, offline fallback) | feature | P2 | 8 |
| [WEB-37](https://github.com/sgsai-lab/home/issues/70) | home | Audit log and per-user rate limits for workspace mutations | security | P1 | 8 |
| [WEB-38](https://github.com/sgsai-lab/home/issues/71) | home | Sector profiles: business engagement vs education programme fields and templates | feature | P2 | 5 |
| [WEB-39](https://github.com/sgsai-lab/home/issues/72) | home | Docs: data model, API reference, Firestore/GCS runbook, privacy notice update | documentation | P2 | 8 |
| [WEB-40](https://github.com/sgsai-lab/home/issues/73) | home | Serve `/.well-known/assetlinks.json` and `apple-app-site-association` for mobile deep links | feature | P1 | 7 |
| [INF-12](https://github.com/sgsai-lab/infrastructure/issues/12) | infrastructure | Provision GCS media buckets with CORS, lifecycle, versioning and a signing service account | setup | P1 | 6 |
| [INF-13](https://github.com/sgsai-lab/infrastructure/issues/13) | infrastructure | Firestore: TTL policies, composite indexes, backups and budget alert | setup | P1 | 4 |
| [INF-14](https://github.com/sgsai-lab/infrastructure/issues/14) | infrastructure | Pause Cloud SQL (INF-08) pending ADR-002; record the decision | decision | P1 | 3 |
| [APP-11](https://github.com/sgsai-lab/mobile-app/issues/21) | mobile-app | Client Hub MVP brief: business & education launcher (answers APP-01) | decision | P0 | 7 |
| [APP-12](https://github.com/sgsai-lab/mobile-app/issues/22) | mobile-app | Workspace switcher and "My projects" list | feature | P1 | 7 |
| [APP-13](https://github.com/sgsai-lab/mobile-app/issues/23) | mobile-app | Apps & services grid: launch client PWA and record the launch event | feature | P1 | 7 |
| [APP-14](https://github.com/sgsai-lab/mobile-app/issues/24) | mobile-app | Deep links: App Links / Universal Links for `/go/*` and `sgsai://` scheme | feature | P1 | 7 |
| [APP-15](https://github.com/sgsai-lab/mobile-app/issues/25) | mobile-app | Project detail screen with media from signed URLs | feature | P2 | 8 |
| [APP-16](https://github.com/sgsai-lab/mobile-app/issues/26) | mobile-app | Offline cache of workspace metadata; empty, error and no-access states | feature | P2 | 8 |
| [APP-17](https://github.com/sgsai-lab/mobile-app/issues/27) | mobile-app | Push notifications for project updates (FCM) | feature | P2, stretch | 8 |
| [API-18](https://github.com/sgsai-lab/backend-api/issues/23) | backend-api | Align projects/products modules with the client-scoped model and ADR-002 | decision | P1 | 3 |
| [API-19](https://github.com/sgsai-lab/backend-api/issues/24) | backend-api | Spike: Firestore → Postgres migration path (export, dual-read, cut-over) | chore | P2, stretch | 8 |

## 10. Decisions log

All five open questions were answered by the founder on 2026-10-27 and recorded in [ADR-002](../adr/0002-firestore-first-data-platform.md). Issues edited to match: home #45, #48, #55, #57, #58, #63, #67, #72; infrastructure #12, #14; backend-api #23; mobile-app #7 (re-titled), #21, #22, #23. Decision comments posted on backend-api #7–#17, infrastructure #8, mobile-app #1 and #4.

Remaining item for the repo owners (not a blocker): choose how to park backend-api #8–#17 (a `Paused` milestone or clearing the milestone) so the board stops showing them as in progress.
