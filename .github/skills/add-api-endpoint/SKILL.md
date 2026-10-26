---
name: add-api-endpoint
description: "Add or change a Node API endpoint, authenticated route, or persistence (Firestore/in-memory) in src/server. Use when: new /api/v1 route, CRUD for a feature, session/auth checks, admin-only action, new Firestore collection, Nginx proxy for API, or writing API tests with node:test."
argument-hint: "HTTP method, path, and what it should do"
---

# Add an API endpoint

`/api/v1/*` and `/go/*` requests go through the router in `src/server/http.mjs` to route tables in `src/server/routes/*.mjs`. Each table is a list of `[method, pattern, handler]` and is registered in `src/server/server.mjs`. Persistence goes through the generic helpers in `src/server/db.mjs`. Browser callers use `api()` from `public/assets/js/auth.js`, which prefixes `/api/v1`, attaches the bearer token and refreshes once on 401.

## Procedure

1. Path: product features live under `/api/v1/...` (proxied by Nginx). Any other new path needs a `location` block in `config/nginx.conf` (never with `add_header` inside it).
2. Write the failing test first in `test/<feature>.test.mjs` using [test-template.mjs](./assets/test-template.mjs) and `test/helpers.mjs`. Run `node --test test/<file>` and confirm it fails for the expected reason.
3. Route: add a handler to the right `src/server/routes/<area>.mjs` (or a new file registered in `server.mjs`) using [route-template.mjs](./assets/route-template.mjs):
   - Auth: `const { user } = await ctx.auth();` (401), `await ctx.admin()` for SGS-admin-only actions (403).
   - Tenancy: load the document, then `await requireMembership(user, doc.client_id, 'admin')` from `authz.mjs`. Other tenants get 404.
   - Input: `const check = new Checker(await ctx.body());` then `check.text/email/oneOf/url/date/tags/...` and `check.done()` (400 with every field problem in `details`).
   - Errors: `throw new HttpError(status, 'CODE', message)`; the dispatcher renders the envelope with a `request_id`.
   - Mutations: `ctx.limit('mutations', user.id)` and `await ctx.audit('thing.created', { type: 'thing', id }, { actorId: user.id, clientId })`.
   - Output: `ctx.send(status, body, headers)`; return only fields the client needs.
4. Persistence: `getDoc`, `setDoc`, `updateDoc(collection, id, mutate)` (transactional read-modify-write; throw `HttpError` inside to abort), `queryDocs(collection, { where: [[field, '==', value]] })`, `deleteWhere`. New collections need no registration. Add TTL by storing a numeric `expires_at`; declare indexes in `config/firestore/firestore.indexes.json` only for hot multi-field queries. Update `docs/data-model.md`.
5. Client: `api('/<path>', { method: 'POST', body: data })`; show errors with `describeError()` and `showStatus()`.
6. Verify: `npm test`, `npm run lint`, and the container check when Nginx or routing changed (verify-and-ship skill). Document the route in `docs/api.md`.

## Rules

- Keep dependencies injectable (`createRequestHandler({ env, sendEmail, storage, verifyGoogleIdToken, ... })`); tests never touch real SMTP, Google, Firestore or Cloud Storage.
- Route order matters only when two patterns match the same path: put literal segments (`/products/by-slug/:slug`) before parameters (`/products/:id`).
- Store secrets and tokens only as SHA-256 digests or AES-GCM ciphertext (`security.mjs`); never log them.
- The in-memory store is per process and disabled in production; do not rely on it for shared state.
