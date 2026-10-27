# Agent guide

Context for AI coding agents working in this repository. Read this first, then load the matching skill in [.github/skills/](.github/skills/) for the task.

## What this is

SGS AI Technology website: framework-free, multi-page HTML/CSS/JavaScript plus a small Node.js 22 API (no Express, no bundler, no TypeScript). Production is one container: Nginx serves the built `dist/` on port 8080 and proxies `/api/*` to the Node API on loopback port 3000. Deployed to Cloud Run from `main` via GitHub Actions.

## Where things live

| Path | Contents |
| --- | --- |
| `public/` | Entire web root. Everything here is deployed publicly. |
| `public/<route>/index.html` | One folder per page route (`/about/`, `/projects/`, ...) with optional `<route>-page.css` |
| `public/assets/js/` | `app.js` (component loader, analytics), `script.js`, account/hub ES modules (`auth.js` API client, `hub.js` shared hub helpers incl. `setupTabs()`, `dialog.js` sheet dialogs and `confirmDialog()`, `upload.js` signed uploads, `workspace.js`, `projects.js`, `admin.js`, `admin-client.js`, `pwa.js`, ...) |
| `public/assets/css/` | `global.css` (tokens, self-hosted fonts, utilities), `account.css` (auth/account pages), `hub.css` (hub design system: workspace, projects, account, admin consoles, sheet dialogs), legacy `styles.css`/`pages.css` |
| `public/workspace/`, `public/admin/clients/` | Client hub: workspace, project detail, invite join, launch bridge, workspace management |
| `public/sw.js`, `public/offline/` | Service worker and offline page (installable hub) |
| `public/components/`, `public/sections/` | Fragments (`.html` + optional `.css`/`.js`) mounted at runtime by `app.js` |
| `src/server/server.mjs` | `createRequestHandler()`: legacy endpoints, request context, router dispatch, error envelope |
| `src/server/routes/*.mjs` | `/api/v1` and `/go/` route tables: auth, users, clients, projects, products, assets, audit |
| `src/server/db.mjs` | Generic Firestore/memory repository (`getDoc`, `setDoc`, `updateDoc`, `queryDocs`, ...), users and sessions |
| `src/server/` (other) | `http.mjs` helpers and router, `security.mjs` (scrypt, TOTP, AES-GCM), `authz.mjs` (workspace roles), `validation.mjs`, `mail.mjs`, `storage.mjs` (GCS), `audit.mjs` |
| `config/firestore/` | Firestore rules (deny all client access) and indexes, applied by the infrastructure repo |
| `config/nginx.conf` | Routing, CSP, caching, API proxy |
| `scripts/` | `build.mjs`, `check-links.mjs`, `preview.mjs`, `check-container.sh`, `review-diff.mjs` (CI Copilot review splitting) |
| `test/` | `node:test` suites |
| `docs/` | [architecture](docs/architecture.md), [deployment](docs/deployment.md), [API](docs/api.md), [data model](docs/data-model.md), [runbook](docs/runbook-firestore-gcs.md), [ADR-002](docs/adr/0002-firestore-first-data-platform.md) |
| `infra/gcp/terraform/` | Infrastructure. Never edit or delete local state/plan/tfvars files. |

## Commands

```sh
npm ci                # install (Node 22, see .nvmrc)
npm run lint          # ESLint + Stylelint + html-validate + source link check
npm test              # API + build-boundary tests
npm run build         # public/ -> minified dist/
npm run check:dist    # link check against dist/ (run after build)
npm run preview       # static dist/ on :4173 (no contact/account API)
npm start             # API only on 127.0.0.1:3000
npm run lighthouse    # Lighthouse budgets (needs Chrome)
docker build -t sgs-ai-website:local . && bash scripts/check-container.sh sgs-ai-website:local
```

Minimum before handing off: `npm run lint && npm test && npm run build && npm run check:dist`.

## Rules

- Preserve public URLs (routes, `/logo/*`, `/assets/*`, favicons, manifest). Moving a file means updating every HTML reference, JS import, and CSS `url()`.
- Root-relative URLs only (`/assets/js/auth.js`), so nested routes resolve.
- Browser code: plain ES2022+, no build step. Account pages use `<script type="module">`; marketing pages use `defer` classic scripts.
- Server code: Node built-ins plus existing dependencies. Validate and sanitize all input in the server (`sanitizeText`, `readJson` size limit). Never expose secrets through `/api/config` or client code.
- Tests must not need SMTP, Google credentials, Firestore or Cloud Storage: use `test/helpers.mjs` (`start`, `account`, `call`, `fakeStorage`), which disables Firestore and injects `sendEmail`/`storage`.
- Follow `.editorconfig` (2 spaces, LF). Conventional Commit subjects (`feat:`, `fix:`, `refactor:`, `docs:`, `chore:`). Branches `features/<topic>`, `fix/<topic>`, `docs/<topic>`; PRs target `main` using the PR template.
- Do not commit `dist/`, `.lighthouseci/`, `node_modules/`, Terraform state, or `.env` files.

## Gotchas

- Reference local CSS/JS as `?v=__ASSET_VERSION__`; `scripts/build.mjs` stamps a content hash of `public/` so every change refetches. Literal `?v=<number>` fails `npm run lint`.
- The navigation fragment mounts inside the header fragment; `app.js` loads the header first on purpose.
- Fragment scripts run immediately after injection, not on `DOMContentLoaded`.
- No top-level `await` in `public/` JavaScript: `scripts/build.mjs` runs terser without module mode and fails. Use `async function main()` + `main().catch(...)`.
- `npm run preview` and Lighthouse run without Nginx, so CSP and API proxy issues only show in the container. The CSP allows only `'self'`, Google/Apple sign-in and `storage.googleapis.com`. `npm run lint` fails on third-party origins the CSP would block, inline `style=`/`on*=` attributes, and `<style>`/inline `<script>` blocks. Fonts are self-hosted in `public/assets/fonts/`.
- Never use `add_header` inside an Nginx `location`: it drops the server-level security headers for that location (`test/nginx.test.mjs` enforces this). Use `expires` for caching.
- Internal links use the trailing-slash form (`/about/`); the link checker rejects `/about`.
- New `/api/v1/*` routes are proxied automatically. Any other new `/api/*` path needs its own `location` block in `config/nginx.conf`.
- Indexable routes must appear in `sitemap.xml`, `ANALYTICS_PATHS` in both `server.mjs` and `app.js`, and `lighthouserc.json`; `noindex` routes must be in `robots.txt`. `test/build.test.mjs` enforces it.
- The in-memory DB fallback is per-process; production disables it (`ALLOW_MEMORY_DB_FALLBACK=false` in the image) so Firestore failures return 503. `FIRESTORE_DISABLED=true` runs locally without Firestore.
- Every tenant document carries `client_id`; authorise with `requireMembership(user, clientId, minRole)` from `authz.mjs`, and return 404 (not 403) for other tenants' resources.

## Skills

| Skill | Use for |
| --- | --- |
| [add-page](.github/skills/add-page/SKILL.md) | New public or signed-in page/route |
| [add-component](.github/skills/add-component/SKILL.md) | New shared component or homepage section |
| [add-api-endpoint](.github/skills/add-api-endpoint/SKILL.md) | New or changed API route, persistence, tests |
| [verify-and-ship](.github/skills/verify-and-ship/SKILL.md) | Validation, container check, commit, PR |
