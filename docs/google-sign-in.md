# Google sign-in

How "Sign in with Google", One Tap ("Continue as <name>"), and automatic sign-in work on the site, and what has to be configured in Google Cloud.

## User experience

On `/login/` (for example `/login/?next=%2Fabout%2F`):

1. **Already signed in to this site** (refresh cookie present): the page shows **Continue as _Full Name_** and returns to `next` on click. Google is not prompted.
2. **Returning Google user, not signed in to this site**: Google One Tap signs the user in automatically (`auto_select`) when exactly one Google account in the browser has signed in to this site before. Google shows a short "Signing in as…" toast, then the page redirects to `next`.
3. **Otherwise**: One Tap shows **Continue as _Name_** with the browser's Google account, and the button renders as personalised "Continue as _Name_". One click signs in or creates the account.

Signing out (or **Use a different account**) revokes the site session and calls Google's `disableAutoSelect()`, so the user is not signed straight back in. `/signup/` uses the same prompt without automatic sign-in.

Google enforces One Tap cooldowns: if a user dismisses the prompt, it is suppressed for a period that grows with repeated dismissals. The button always works.

## How it works

```mermaid
sequenceDiagram
  participant B as Browser (/login/)
  participant G as Google Identity Services
  participant A as Node API (/api/v1)
  participant F as Firestore
  B->>A: GET /api/config
  A-->>B: googleClientId
  B->>G: initialize(client_id, nonce, auto_select), prompt()
  G-->>B: ID token (JWT signed by Google)
  B->>A: POST /auth/google {id_token, nonce}
  A->>A: verify signature, iss, aud = GOOGLE_CLIENT_ID, exp, nonce, email_verified
  A->>F: upsert users/{id}; store sessions/{sha256}, refresh_tokens/{sha256}
  A-->>B: access token (1 h) + Set-Cookie sgsai_refresh (HttpOnly, Secure, SameSite=Strict, 30 d)
  B->>B: store access token in sessionStorage, redirect to next
```

| Piece | File |
| --- | --- |
| Loads GIS, button, One Tap, auto-select, sign-out handling | [public/assets/js/google.js](../public/assets/js/google.js) |
| Shared Google/Apple buttons, One Tap trigger | [public/assets/js/auth-providers.js](../public/assets/js/auth-providers.js) |
| "Continue as" for existing sessions, `next` redirect | [public/assets/js/login.js](../public/assets/js/login.js), `offerContinueAs()` in [auth.js](../public/assets/js/auth.js) |
| ID token verification (Google certs, Apple JWKS) | [src/server/identity.mjs](../src/server/identity.mjs) |
| Sign-in, refresh, sign-out, linking routes | [src/server/server.mjs](../src/server/server.mjs) |
| Users, sessions, refresh tokens in Firestore | [src/server/db.mjs](../src/server/db.mjs) |
| Tests | [test/auth.test.mjs](../test/auth.test.mjs) |

Security properties:

- The API trusts a Google identity only after `google-auth-library` verifies the token signature against Google's certificates, the issuer, the audience (`GOOGLE_CLIENT_ID`), expiry, and the nonce. Without `GOOGLE_CLIENT_ID` the endpoint returns 503 rather than accepting tokens.
- Accounts are matched by Google subject, then by email, so unverified Google emails (`email_verified: false`) are rejected.
- Access tokens live 1 hour in `sessionStorage` (per tab). The refresh token is an HttpOnly cookie scoped to `/api/v1/auth`, is single-use (rotated on every refresh), and is revoked by sign-out. Sign out everywhere revokes all of the user's tokens.
- Firestore stores SHA-256 digests of tokens, never the tokens themselves.
- No client secret is used: GIS ID-token sign-in only needs the public client ID.

## Google Cloud configuration (one-time)

Project: `home-509818`. Requires a project Owner/Editor or OAuth config admin.

1. **Branding**: open [Google Auth Platform](https://console.cloud.google.com/auth/overview?project=home-509818) and complete **Branding**:
   - App name `SGS AI Technology`, user support email, and logo (optional; a logo triggers brand verification).
   - Home page `https://www.sgsaitechnology.com/`, privacy policy `https://www.sgsaitechnology.com/privacy/`, terms `https://www.sgsaitechnology.com/terms/`.
   - Authorized domain `sgsaitechnology.com`.
2. **Audience**: user type **External**, then **Publish app** (In production). The site requests only `openid email profile`, which are non-sensitive, so no Google app verification is required.
3. **Client**: **Clients → Create client → Web application**, name `sgsai-website`:
   - Authorized JavaScript origins:
     - `https://www.sgsaitechnology.com`
     - `https://sgsaitechnology.com`
     - `http://localhost` and `http://localhost:8080` (local container testing; GIS needs both forms for localhost)
   - Authorized redirect URIs: none (popup and One Tap do not redirect).
   - Copy the **Client ID** (`…apps.googleusercontent.com`). Ignore the client secret.
4. **Deploy configuration**: the deploy workflow passes the GitHub repository variable to Cloud Run:

   ```sh
   gh variable set GOOGLE_CLIENT_ID --repo sgsai-lab/home --body "<client-id>.apps.googleusercontent.com"
   ```

   Then redeploy (merge to `main`, or re-run **Deploy website to Cloud Run**). The client ID is public; it is served by `/api/config`.
5. **Verify**: `curl https://www.sgsaitechnology.com/api/config` returns your `googleClientId`, and `/login/?next=%2Fabout%2F` shows the Google button.

The Nginx CSP in [config/nginx.conf](../config/nginx.conf) already allows `accounts.google.com/gsi/` scripts, styles, frames, and connections, and `*.googleusercontent.com` profile images. `Referrer-Policy: strict-origin-when-cross-origin` is required by GIS; do not change it to `no-referrer`.

## Firestore (Firebase) configuration

User and session data is stored in the project's Firestore **(default)** database in Native mode. The Cloud Run runtime service account already has `roles/datastore.user` (Terraform `runtime_datastore`).

1. Confirm the database exists (or create it; the location cannot be changed later):

   ```sh
   gcloud firestore databases list --project home-509818
   gcloud firestore databases create --project home-509818 --location=asia-south1 --type=firestore-native
   ```

2. Enable TTL so expired tokens are deleted automatically (uses the `expire_at` timestamp field):

   ```sh
   gcloud firestore fields ttls update expire_at --collection-group=sessions --enable-ttl --project home-509818
   gcloud firestore fields ttls update expire_at --collection-group=refresh_tokens --enable-ttl --project home-509818
   ```

| Collection | Document ID | Fields |
| --- | --- | --- |
| `users` | `usr_<uuid>` | `email`, `full_name`, `avatar_url`, `role` (`user`/`admin`), `provider`, `provider_id`, `email_verified`, `created_at`, `last_login_at`, `updated_at`, optional `google_linked`, `google_sub` |
| `sessions` | SHA-256 of access token | `user_id`, `expires_at` (ms), `expire_at` (timestamp), `created_at` |
| `refresh_tokens` | SHA-256 of refresh token | same as `sessions` |

To make someone an administrator, set `role` to `admin` on their `users` document in the Firestore console.

If Firestore is unreachable, the API logs an error and falls back to per-instance memory, which does not survive restarts or span Cloud Run instances. Treat those log lines as an incident.

`node scripts/verify-google-login.mjs` (with `gcloud auth login`) writes and reads a sample user through Firestore, then deletes it.

## Local testing

- `npm test` covers token verification (forged, wrong audience/issuer, expired, nonce mismatch), unverified emails, refresh rotation and reuse, sign-out, sign out everywhere, Apple verification, and Google account linking, all offline.
- Real Google sign-in needs a browser origin listed in the OAuth client. Build and run the container on port 8080 with `-e GOOGLE_CLIENT_ID=…`, then open `http://localhost:8080/login/?next=%2Fabout%2F`.

## Rollout notes

- Deploying this change invalidates sessions issued by the previous version (tokens are now stored hashed); users sign in once more.
- Until `GOOGLE_CLIENT_ID` is set, the Google button shows "not available" and the API returns 503 for Google sign-in.
