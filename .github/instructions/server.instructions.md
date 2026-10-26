---
description: "Use when editing the Node API, persistence, or API tests in src/server/ or test/."
applyTo: "src/server/**,test/**"
---

# Server conventions

- Plain `node:http`, no framework. `createRequestHandler()` in `src/server/server.mjs` handles the legacy endpoints (`/api/contact`, `/api/config`, `/api/analytics`, `/api/readyz`, `/.well-known/*`) and dispatches `/api/v1/*` and `/go/*` through the router (`createRouter` in `http.mjs`) to route tables in `src/server/routes/*.mjs` (`[method, '/api/v1/things/:id', handler]`).
- Handlers receive `ctx`: `ctx.auth()` (401 unless an active user), `ctx.admin()` (403 unless SGS admin), `ctx.optionalAuth()`, `ctx.body()` (JSON object, 12 KB), `ctx.limit(name, key)` (429), `ctx.audit(action, target, { actorId, clientId, diff })`, `ctx.send(status, body, headers)`, `ctx.params`, `ctx.query`, `ctx.client` (`web|android|ios`).
- Errors: `throw new HttpError(status, CODE, message, details)`; the dispatcher renders `{ error: { code, message, details, request_id } }`, maps `DatabaseUnavailableError` to 503 and anything else to 500 with a logged request id. Unsupported methods get 405 with `Allow` automatically.
- Validate with `Checker` from `validation.mjs` (collects every field problem), sanitize strings (`sanitizeText`), and allow only `https://` URLs.
- Tenancy: load the resource, then `requireMembership(user, resource.client_id, minRole)` from `authz.mjs`. Other tenants get 404. Only SGS admins (`role === 'admin'`) cross tenants.
- Persistence: use the generic helpers in `db.mjs` (`getDoc`, `setDoc`, `updateDoc` for read-modify-write in a transaction, `queryDocs` with equality filters, `deleteWhere`, single-use token helpers). Store tokens only as SHA-256 digests. A numeric `expires_at` adds the `expire_at` TTL field automatically.
- Never log secrets, tokens, codes or email bodies. Use `log()` from `http.mjs` for structured JSON logs.
- Tests: `node:test` + `assert/strict` with `test/helpers.mjs` (`start` disables Firestore and rate limits, injects `sendEmail` and a fake storage; `account` creates a signed-in user; `call` returns `{ status, data, headers }`). Use `realLimits: true` only for throttling tests. Cover tenant isolation with a negative test.
- Non-`/api/v1/` paths need a matching `location` in `config/nginx.conf` (and never `add_header` inside a location).
