# Agent guide

Context for AI coding agents working in this repository. Read this first, then load the matching skill in [.github/skills/](.github/skills/) for the task.

## What this is

SGS AI Technology website: framework-free, multi-page HTML/CSS/JavaScript plus a small Node.js 22 API (no Express, no bundler, no TypeScript). Production is one container: Nginx serves the built `dist/` on port 8080 and proxies `/api/*` to the Node API on loopback port 3000. Deployed to Cloud Run from `main` via GitHub Actions.

## Where things live

| Path | Contents |
| --- | --- |
| `public/` | Entire web root. Everything here is deployed publicly. |
| `public/<route>/index.html` | One folder per page route (`/about/`, `/projects/`, ...) with optional `<route>-page.css` |
| `public/assets/js/` | `app.js` (component loader), `script.js`, account ES modules (`auth.js` API client, `login.js`, `projects.js`, ...) |
| `public/assets/css/` | `global.css` (tokens, layout, buttons), `account.css` (auth/account pages), legacy `styles.css`/`pages.css` |
| `public/components/`, `public/sections/` | Fragments (`.html` + optional `.css`/`.js`) mounted at runtime by `app.js` |
| `src/server/server.mjs` | All API routes in one `createRequestHandler()` |
| `src/server/db.mjs` | Users/sessions persistence: Firestore with in-memory fallback |
| `config/nginx.conf` | Routing, CSP, caching, API proxy |
| `scripts/` | `build.mjs`, `check-links.mjs`, `preview.mjs`, `check-container.sh` |
| `test/` | `node:test` suites |
| `docs/` | [architecture](docs/architecture.md), [deployment](docs/deployment.md) |
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
- Tests must not need SMTP, Google credentials, or Firestore: use `setFirestoreDisabled(true)` and injected `sendMail`.
- Follow `.editorconfig` (2 spaces, LF). Conventional Commit subjects (`feat:`, `fix:`, `refactor:`, `docs:`, `chore:`). Branches `features/<topic>`, `fix/<topic>`, `docs/<topic>`; PRs target `main` using the PR template.
- Do not commit `dist/`, `.lighthouseci/`, `node_modules/`, Terraform state, or `.env` files.

## Gotchas

- `app.js` loads fragments with `?v=7`; bump that version (and the `?v=7` on `global.css`/`app.js` links) when changing component/section HTML, CSS, or JS so browsers refetch.
- The navigation fragment mounts inside the header fragment; `app.js` loads the header first on purpose.
- Fragment scripts run immediately after injection, not on `DOMContentLoaded`.
- No top-level `await` in `public/` JavaScript: `scripts/build.mjs` runs terser without module mode and fails. Use `async function main()` + `main().catch(...)`.
- `npm run preview` and Lighthouse run without Nginx, so CSP and API proxy issues only show in the container. The CSP in `config/nginx.conf` allows only `'self'` plus Google/Apple sign-in origins; existing references to Google Fonts, Font Awesome (cdnjs), and Plausible are blocked in production. Adding any third-party origin requires a CSP change.
- New `/api/v1/*` routes are proxied automatically. Any other new `/api/*` path needs its own `location` block in `config/nginx.conf`.
- Analytics accepts only paths in `ANALYTICS_PATHS` in `server.mjs`.
- The in-memory DB fallback is per-process; it is not shared across Cloud Run instances.

## Skills

| Skill | Use for |
| --- | --- |
| [add-page](.github/skills/add-page/SKILL.md) | New public or signed-in page/route |
| [add-component](.github/skills/add-component/SKILL.md) | New shared component or homepage section |
| [add-api-endpoint](.github/skills/add-api-endpoint/SKILL.md) | New or changed API route, persistence, tests |
| [verify-and-ship](.github/skills/verify-and-ship/SKILL.md) | Validation, container check, commit, PR |
