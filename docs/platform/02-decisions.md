# 2. Decisions

Each entry says what was decided, why, and what it costs. "Founder" decisions were confirmed on 2026-10-26/27 (all recommended options were accepted). Architecture decision records (ADRs) are linked where they exist.

## Index

| ID | Decision | Type |
| --- | --- | --- |
| [D1](#d1-who-gets-an-account) | Accounts are for client staff and SGS staff only | Founder |
| [D2](#d2-business-and-education-as-a-sector-per-project) | Business vs education is a sector on each project | Founder |
| [D3](#d3-one-identity-system-for-web-and-mobile) | Mobile uses the same SGS tokens as the web (no Firebase Auth) | Founder |
| [D4](#d4-home-owns-apiv1-for-now-adr-002) | `home` owns `/api/v1` on Firestore; `backend-api` paused | Founder, ADR-002 |
| [D5](#d5-firestore-native-mode-metadata-only) | Firestore Native for metadata; files in Cloud Storage | Founder, ADR-002 |
| [D6](#d6-two-buckets-private-media-and-public-icons) | Private media bucket plus a small public icon bucket | Founder |
| [D7](#d7-client-apps-open-only-for-signed-in-members) | `/go/{slug}` for client apps requires a signed-in member | Founder |
| [D8](#d8-mobile-timeline) | Mobile internal build Week 7 (Dec 2026), private beta Q1 2027 | Founder |
| [D9](#d9-approvals) | The founder approves plans and releases | Founder |
| [D10](#d10-postgres-later-by-big-bang-cut-over-adr-003) | Postgres later, by export → import → upstream switch | ADR-003 |
| [D11](#d11-no-framework-no-bundler) | Keep the framework-free site; no SPA, no bundler | Technical |
| [D12](#d12-workspace-roles-and-404-for-other-tenants) | Four workspace roles; other tenants get 404 | Technical |
| [D13](#d13-invitations-instead-of-direct-adds) | Client admins invite; only SGS admins add accounts directly | Security |
| [D14](#d14-session-families-and-refresh-token-rotation) | Session families, rotating single-use refresh tokens | Security |
| [D15](#d15-provider-sign-in-cannot-inherit-an-unverified-account) | Google/Apple sign-in discards an unverified look-alike account | Security |
| [D16](#d16-uploads-go-to-pending-then-get-promoted) | Uploads land in `pending/` and are promoted on confirm | Technical |
| [D17](#d17-per-instance-rate-limits-plus-nginx-limits-keyed-on-the-real-client) | Per-instance limits; Nginx keyed on the real client IP | Technical |
| [D18](#d18-production-never-falls-back-to-memory) | Production returns 503 instead of falling back to memory | Reliability |
| [D19](#d19-one-error-envelope-across-services) | Identical error envelope in `home` and `backend-api` | Technical |
| [D20](#d20-content-hash-asset-versions-and-a-strict-csp) | Content-hash asset versions; CSP with no third parties | Technical |
| [D21](#d21-keyless-delivery-and-secrets-by-reference) | Workload Identity Federation; secrets referenced by name | Security |
| [D22](#d22-email-from-no-replysgsaitechnologycom-through-google-workspace) | Email through Google Workspace SMTP as `no-reply@` | Operations |
| [D23](#d23-missing-account-status-means-active) | A missing `status` on an account means active | Fix (#80) |
| [D24](#d24-public-read-on-the-icon-bucket-is-opt-in) | Public read on the icon bucket is opt-in | Infra (#19) |

---

### D1. Who gets an account

- **Decision:** Only staff of client organisations and SGS AI staff have accounts. SGS AI does not create accounts for students or for a client's own customers; those use the client's apps.
- **Why:** Keeps personal-data scope small (privacy notice updated), keeps the hub a B2B tool, and avoids building consumer-scale identity.
- **Consequence:** Client apps authenticate their own end users. The hub only launches them.

### D2. Business and education as a sector per project

- **Decision:** A client has a `primary_sector`, but each **project** has its own `sector` (`business` or `education`) with a sector profile and milestone template.
- **Why:** A university can run a business-style engagement (e.g. an admin system), and a company can run training. Per-project sectors avoid forcing a client into one box.
- **Consequence:** Sector profiles are validated per sector: business `{engagement_type, department}`, education `{institution_type, programme, cohort, academic_year}`. Templates: business *Discovery → Proposal → Build → UAT → Handover*; education *Needs analysis → Pilot cohort → Rollout → Term review*.

### D3. One identity system for web and mobile

- **Decision:** The mobile app signs in against `home`'s API and uses the same access/refresh tokens. Firebase Auth was removed from the app.
- **Why:** One user store, one session list, one place to revoke access, and the same MFA and admin rules on every platform.
- **Consequence:** The API supports `X-Client: mobile`: refresh tokens are returned in JSON (not as a cookie) and stored in the device keystore. Google/Apple native sign-in buttons need OAuth and signing configuration (mobile issue #7).

### D4. `home` owns `/api/v1` for now (ADR-002)

- **Decision:** For at least six weeks the Node API in `home` is the system of record for `/api/v1`. Feature work on `backend-api` (API-07…16) is paused.
- **Why:** One small team, one deployable, no cross-service auth, and Firestore needs no database server. The fastest route to a working client hub.
- **Consequence:** `backend-api` aligned its error envelope and contract with `home` (sgsai-lab/backend-api#25) so it can take over later by switching Nginx's `API_UPSTREAM` ([D10](#d10-postgres-later-by-big-bang-cut-over-adr-003)). See [ADR-002](../adr/0002-firestore-first-data-platform.md).

### D5. Firestore Native mode, metadata only

- **Decision:** Firestore Native in `asia-south1` stores metadata. Original files go to Cloud Storage.
- **Why:** Serverless, pay per use, transactions, TTL and point-in-time recovery out of the box; large files are cheaper and faster in a bucket with signed URLs.
- **Consequence:** Queries are equality filters; sorting and search happen in the API on small result sets. Client SDK access is denied by Firestore rules: the API's service account is the only reader and writer.

### D6. Two buckets: private media and public icons

- **Decision:** `sgsai-media-prod` is private (uniform access, public access prevention, versioning, 30-day noncurrent retention, video to Nearline after 90 days, `pending/` deleted after 1 day). `sgsai-public-assets-prod` holds only icons of apps marked public.
- **Why:** Client files must never be public by mistake; the public `/products/` page still needs icons without signing.
- **Consequence:** Icons are **copied** to the public bucket when an app becomes public and removed when it stops being public. See [D24](#d24-public-read-on-the-icon-bucket-is-opt-in) for the current state.

### D7. Client apps open only for signed-in members

- **Decision:** `/go/{slug}` opens a public app immediately, but a client-only app needs a single-use 60-second launch token issued to a signed-in member.
- **Why:** Shared links must not leak access to client systems, and launches should be attributable (who, from which platform).
- **Consequence:** A bare link to a client app redirects to `/workspace/launch/?slug=…`, which signs the person in, checks membership, gets a token and continues. Launches are recorded for 180 days with `utm_source=sgsai_hub`.

### D8. Mobile timeline

- **Decision:** Internal build in Week 7 of the plan (December 2026); private beta in Q1 2027. The public `/products/` page says "Targeting a Q1 2027 private beta".
- **Consequence:** App Links/Universal Links files are served from configuration (`ANDROID_CERT_SHA256`, `APPLE_TEAM_ID`) and return 404 until those are set.

### D9. Approvals

- **Decision:** The founder approves the plan, decisions and releases; AI agents open PRs but never merge them.

### D10. Postgres later, by big-bang cut-over (ADR-003)

- **Decision:** When Firestore stops fitting, `backend-api` takes over `/api/v1` on PostgreSQL through export → import → contract test → `API_UPSTREAM` switch during a short read-only window. Dual-write was rejected.
- **Why:** Data volume is small; dual-write adds a second code path and partial-failure handling for little benefit.
- **Consequence:** A tested spike exists (models, migration, idempotent loader, byte-identical contract replay). See [Postgres migration path](11-postgres-migration-path.md).

### D11. No framework, no bundler

- **Decision:** Keep the multi-page HTML/CSS/JS site and plain ES modules; the API is plain `node:http` with a small router.
- **Why:** The existing site is framework-free, fast, and easy to audit; adding React/Express would add dependencies without solving a real problem.
- **Consequence:** A small build script minifies and stamps asset versions; lint rules replace what a framework would enforce (CSP-safe markup, link format).

### D12. Workspace roles and 404 for other tenants

- **Decision:** Roles `viewer < member < admin < owner`; SGS admins act as owners everywhere. Requests for another tenant's resources answer `404`, never `403`.
- **Why:** Simple to explain to clients; `404` does not confirm that a resource exists.
- **Consequence:** Every handler loads the document and calls `requireMembership(user, doc.client_id, minRole)`. A workspace always keeps at least one owner (`409 LAST_OWNER`).

### D13. Invitations instead of direct adds

- **Decision:** Workspace admins add people by email invitation. Adding an existing account directly is SGS-admin only.
- **Why:** A direct "add by email" answers "does this email have an account?", which lets a client admin probe registrations. Found in the pre-merge security review.
- **Consequence:** Invitations are single use, expire in 7 days, and resending invalidates the previous link. Signing up through an invitation verifies the address.

### D14. Session families and refresh-token rotation

- **Decision:** Each sign-in creates a session family. Access tokens live 1 hour; refresh tokens rotate on every use and are single use. Presenting a spent refresh token revokes the whole family.
- **Why:** A stolen refresh token becomes useless as soon as either party uses it, and the user sees each device and can revoke it.
- **Consequence:** Clients must serialise refresh (the mobile `AuthInterceptor` is a queued interceptor so parallel 401s cause one refresh).

### D15. Provider sign-in cannot inherit an unverified account

- **Decision:** If Google/Apple sign-in matches an email that belongs to an **unverified** password account, that account's password, MFA and sessions are discarded before the provider identity is attached.
- **Why:** Otherwise an attacker could pre-register the victim's email with a password and keep access after the victim signs in with Google. Found in the pre-merge security review.

### D16. Uploads go to `pending/` then get promoted

- **Decision:** Signed upload URLs point at `pending/<object>`. `POST /assets/{id}/confirm` checks size and content type in storage, then moves the object to its final name.
- **Why:** Abandoned or mismatched uploads are cleaned up by a bucket lifecycle rule (1 day) and a Firestore TTL (24 h) without a cron job.

### D17. Per-instance rate limits, plus Nginx limits keyed on the real client

- **Decision:** API limits are in-memory per instance (max 5 instances). Nginx limits the contact form (10/min) and launch links (120/min) by the client IP from the last `X-Forwarded-For` entry, and passes that header through unchanged.
- **Why:** Cheaper than a Firestore-backed counter. The Copilot review of #78 led to the discovery that `$binary_remote_addr` and `$proxy_add_x_forwarded_for` both see Cloud Run's front end, which would have made all visitors share one limit.
- **Correction (2026-10-27):** Behind the external load balancer, the last `X-Forwarded-For` entry is the load balancer's address, not the visitor's, so production limits are still shared by everyone. Fix tracked in #81: skip the load balancer hop and use the entry before it. See [incident 3](10-operations.md#incident-3-rate-limits-shared-by-all-visitors).

### D18. Production never falls back to memory

- **Decision:** The image sets `ALLOW_MEMORY_DB_FALLBACK=false`; a Firestore failure returns `503 SERVICE_UNAVAILABLE`. `/api/readyz` reports `database: firestore`.
- **Why:** A silent per-instance memory store would give different users different data and lose writes.

### D19. One error envelope across services

- **Decision:** `{error: {code, message, details[], request_id}}` with codes `UNAUTHORIZED`, `FORBIDDEN`, `NOT_FOUND`, `VALIDATION_ERROR` (400), `RATE_LIMITED`, `SERVICE_UNAVAILABLE`. `backend-api` changed `requestId`/`UNAUTHENTICATED`/`RESOURCE_NOT_FOUND`/422 to match.
- **Why:** Web and mobile clients parse one shape, and the upstream switch in D10 needs no client change.

### D20. Content-hash asset versions and a strict CSP

- **Decision:** Pages reference local CSS/JS as `?v=__ASSET_VERSION__`; the build replaces it with a hash of `public/`. Fonts and icons are self-hosted; the CSP allows no other third parties. Lint rejects literal versions, unversioned local assets, inline styles/handlers/scripts and CSP-blocked origins.
- **Why:** Previously `?v=7` was bumped by hand and forgotten; Google Fonts, Font Awesome and Plausible were silently blocked by the CSP in production.

### D21. Keyless delivery and secrets by reference

- **Decision:** GitHub Actions authenticate to Google Cloud with Workload Identity Federation. GitHub repository variables hold only **names** of Secret Manager secrets (`SMTP_PASS_SECRET=sgsai-smtp-pass`); Cloud Run mounts them with `--set-secrets`.
- **Why:** No long-lived keys in GitHub; rotating a secret is `gcloud secrets versions add` plus a redeploy.

### D22. Email from `no-reply@sgsaitechnology.com` through Google Workspace

- **Decision:** `smtp.gmail.com:587` with the `huggi.vittal@` mailbox and an app password; sender `no-reply@` is an alias of that mailbox.
- **Why:** No extra provider or cost. Consequence: Google Workspace sending limits apply (about 2,000 messages per day), which is ample for account email; a transactional provider can replace it by changing four variables.

### D23. Missing account status means active

- **Decision:** User reads default a missing `status` to `active` (#80).
- **Why:** Accounts created before #78 had no `status`, and the new checks treated them as disabled. See [incident 1](10-operations.md#incident-1-existing-accounts-reported-as-disabled).

### D24. Public read on the icon bucket is opt-in

- **Decision (infrastructure#19):** `allUsers` read on `sgsai-public-assets-prod` is created only when `public_read = true`, which needs an organisation policy exception (`iam.allowedPolicyMemberDomains`).
- **Consequence:** Until it is enabled (or icons are served another way), icon URLs of public apps return 403 and their images fail to load on `/products/`. Tracked in [open items](10-operations.md#open-items).
