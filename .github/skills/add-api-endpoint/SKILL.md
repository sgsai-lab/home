---
name: add-api-endpoint
description: "Add or change a Node API endpoint, authenticated route, or persistence (Firestore/in-memory) in src/server. Use when: new /api/v1 route, CRUD for a feature, session/auth checks, admin-only action, new Firestore collection, Nginx proxy for API, or writing API tests with node:test."
argument-hint: "HTTP method, path, and what it should do"
---

# Add an API endpoint

All routes live in `createRequestHandler()` in `src/server/server.mjs` as sequential `if (pathname === ...)` branches before the final 404. Persistence lives in `src/server/db.mjs`. Browser callers use `api()` from `public/assets/js/auth.js`, which prefixes `/api/v1` and attaches the bearer token.

## Procedure

1. Path: put account/product features under `/api/v1/...` (already proxied by Nginx). A new non-v1 `/api/*` path also needs a `location` block in `config/nginx.conf` mirroring `/api/config`.
2. Write the failing test first in `test/server.test.mjs` (or a new `test/<feature>.test.mjs`) using [test-template.mjs](./assets/test-template.mjs). Run `node --test test/<file>` and confirm it fails for the expected reason.
3. Persistence, if needed: add exported async functions to `src/server/db.mjs` following `findUserByProvider`/`saveSession`. Try Firestore via `getFirestore()`, catch and `console.error`, then fall back to a `memoryStore` map. Add the new map to `memoryStore` and clear it in `resetInMemoryDb()`. Generate IDs with `randomUUID()`.
4. Route: add a branch using [route-template.mjs](./assets/route-template.mjs). Required:
   - Auth: `const session = await getSession(getBearerToken(request));` → 401 `UNAUTHORIZED`; load `getUserById(session.user_id)`. Admin-only: 403 `FORBIDDEN` unless `user.role === 'admin'` (users default to `'user'`). The browser's `requireUser({ admin: true })` is UI gating only, not authorization.
   - Input: `readJson(request)` (12 KB limit, throws `statusCode`), then `sanitizeText(value, max)` each string; validate required fields → 400 `VALIDATION_ERROR`.
   - Output: `respond(response, status, body)`; errors as `{ error: { code, message } }`; unsupported methods → 405 with `Allow` header.
   - Return only fields the client needs; never env values or other users' data.
   - Public, unauthenticated write endpoints need rate limiting with `allowRequest(clientAddress(request))` like `/api/contact`.
5. Client: call `api('/<path>', { method: 'POST', body: JSON.stringify(data) })` from the page module; handle `ApiError` with `describeError()` and `showStatus()`.
6. Verify: `npm test`, `npm run lint`, and when routing/proxy changed, the container check (verify-and-ship skill). Update `docs/architecture.md` if the API surface changes notably.

## Rules

- Keep `createRequestHandler` options injectable; never call real SMTP, Google, or Firestore from tests (`setFirestoreDisabled(true)`).
- `server.mjs` routes are order-sensitive: place specific paths before prefix matches like `pathname.startsWith('/api/v1/auth/sessions/')`.
- The in-memory fallback is per process; do not rely on it for production data.
