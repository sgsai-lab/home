# Architecture

## System boundaries

The application is a multi-page HTML/CSS/JavaScript website with a Node.js API, not a single-page application. Nginx serves the built web root and proxies same-origin API requests. This layout preserves the existing framework-free implementation and public page routes.

| Directory | Responsibility |
| --- | --- |
| `public/` | Deployable browser source, page entry points, and static metadata |
| `public/assets/css/` | Shared layout, global, and account styles |
| `public/assets/js/` | Shared loader, page behavior, and account modules |
| `public/components/` | Reusable header, navigation, footer, and floating actions |
| `public/sections/` | Homepage sections with colocated styles and behavior |
| `public/<route>/` | Route-specific HTML and styles |
| `public/vendor/` | Third-party browser code, including the account QR-code library |
| `src/server/` | HTTP API and persistence adapter; never published as static files |
| `config/` | Nginx configuration |
| `scripts/` | Build, preview, validation, and operational tooling |
| `test/` | Node test runner suites |
| `infra/gcp/` | Terraform and infrastructure-specific operations |
| `docs/` | Architecture and application operations |

Package manifests, lockfiles, tool-discovered lint configuration, EditorConfig, Dockerfile, and contribution guidance remain at the repository root. No framework or workspace package layer is needed for these two small runtime boundaries.

## Browser composition

[The loader](../public/assets/js/app.js) reads its component list and mounts HTML into page placeholders. It loads the header first because the navigation mount lives inside that fragment, then loads the remaining components concurrently. CSS and JavaScript are loaded only when the corresponding component declares them. Floating contact actions are mounted on every page.

Shared scripts use root-relative asset URLs so nested routes resolve consistently. Account modules import other browser modules from `/assets/js/`. Component and section resources remain colocated and retain their existing URLs.

Global styles live in `public/assets/css/`; route-specific and component-specific styles stay with their owners. Preserve stylesheet ordering when changing a page. Keep branding URLs, favicons, the web manifest, sitemap, and robots file stable where they are already publicly referenced.

The loader preserves existing hash navigation behavior: product, vision, about, roadmap, and approach anchors redirect to their corresponding pages, while local anchors wait for components to load before scrolling.

## API and persistence

[The API](../src/server/server.mjs) is the system of record for the client hub ([ADR-002](adr/0002-firestore-first-data-platform.md)) and serves the website and the mobile app. `createRequestHandler()` answers the legacy endpoints (contact, analytics, provider configuration, readiness, app-link association files) and dispatches `/api/v1/*` and `/go/*` through a small router to [route tables](../src/server/routes/) for authentication, users, workspaces (clients, memberships, invites), projects, products and launch links, assets and the audit log. Each request gets a context with authentication, rate limiting, auditing and a request id; errors share one envelope. See the [API reference](api.md).

[The persistence layer](../src/server/db.mjs) is a generic Firestore repository with an in-memory implementation for tests and local work; production disables the fallback so outages surface as `503`. Binaries never pass through the API: browsers and the app upload to and read from Cloud Storage with V4 signed URLs ([storage adapter](../src/server/storage.mjs)). Collections, TTLs and indexes are described in the [data model](data-model.md).

Tenancy: every workspace document carries `client_id`, and handlers authorise with `requireMembership()` ([authz](../src/server/authz.mjs)): roles viewer < member < admin < owner, with SGS administrators acting as owners everywhere. Other tenants' resources answer `404`.

The included container runs the API on port 3000 and Nginx on port 8080. Nginx routes `/api/contact`, `/api/analytics`, `/api/config`, `/api/readyz`, `/go/` and the two `/.well-known/` association files to the local API; `/api/v1/` uses `API_UPSTREAM`, which defaults to that same API (ADR-002 keeps the contract identical so it can later point at `backend-api`). The standalone preview is not an API proxy.

## Client hub in the browser

Signed-in pages are ES modules on top of `auth.js` (API client with token refresh) and `hub.js` (labels, workspace selection, signed-URL cache). `/workspace/` is the launcher: apps open through `/go/{slug}`, and client-only apps bounce through `/workspace/launch/`, which signs the visitor in and returns with a single-use launch token. The site is an installable PWA: [sw.js](../public/sw.js) caches only the shell (never API responses or launch links), and the workspace keeps an offline snapshot of names and links that is cleared on sign-out.

## Build and deployment boundary

`npm run build` recreates `dist/` from `public/`, minifies HTML/CSS/JavaScript, and copies other assets unchanged. The build resolves paths from the script location, not the calling working directory. Adding a public page no longer requires editing a build allowlist.

Everything placed in `public/` is deployable. Never place credentials, private documents, server code, or infrastructure state there. Only `dist/` is copied into the Nginx document root; Node source and production dependencies are copied separately into the image.

Nginx resolves directory indexes and `.html` routes and returns the branded 404 page with a real 404 status for unknown routes. It does not rewrite all requests into the homepage.

## Verification

- `npm run lint`: JavaScript, CSS, HTML, source links, and dynamic resources.
- `npm test`: API behavior and the public-only build contract, including execution from another working directory and unchanged non-code assets.
- `npm run check:dist`: built pages, local links, and dynamic resources against the source loader's component list. Run a build first.
- `npm run lighthouse`: existing browser quality budgets against the built site.
- `bash scripts/check-container.sh IMAGE`: homepage, API configuration, shared assets, and dynamic header in the actual container.

The source loader remains the component contract for link checks, so validation does not depend on how the minifier rewrites its JavaScript. Link checks cover HTML references and declared dynamic fragments; browser checks are still needed for module imports, CSS resources, and runtime behavior.

See [contribution guidelines](../CONTRIBUTING.md) for coding standards and [deployment](deployment.md) for release and rollback procedures.