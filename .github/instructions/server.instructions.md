---
description: "Use when editing the Node API, persistence, or API tests in src/server/ or test/."
applyTo: "src/server/**,test/**"
---

# Server conventions

- Plain `node:http`; all routes are `if (pathname === ...)` branches inside `createRequestHandler()` in `src/server/server.mjs`, ending with the 404 response. Keep the injectable options (`env`, `allowRequest`, `sendMail`, `recordPageView`) for testability.
- Respond only via `respond(response, status, body)` (JSON, `no-store`, `nosniff`). `/api/v1/*` errors use `{ error: { code, message } }`; unsupported methods return 405 with an `Allow` header.
- Parse bodies with `readJson` (12 KB limit) and sanitize every string with `sanitizeText(value, maxLength)`. Never echo secrets or env values.
- Authenticated routes: `getSession(getBearerToken(request))`, return 401 `UNAUTHORIZED` when missing, then `getUserById(session.user_id)`. No admin routes exist yet; `requireUser({ admin: true })` in the browser only hides UI, so any admin-only route must itself return 403 `FORBIDDEN` unless `user.role === 'admin'`.
- Persistence lives in `src/server/db.mjs`: each function tries Firestore (`getFirestore()`), logs and falls back to `memoryStore` on failure. Add new collections the same way and clear them in `resetInMemoryDb()`.
- Tests use `node:test` + `assert/strict`, call `setFirestoreDisabled(true)`, start `createServer(...)` on port 0, close it in `t.after`, and inject fakes instead of real SMTP/Google/Firestore.
- Non-`/api/v1/` paths need a matching `location` in `config/nginx.conf`.
