# 3. Identity and sessions

Code: [routes/auth.mjs](../../src/server/routes/auth.mjs), [db.mjs](../../src/server/db.mjs) (sessions), [security.mjs](../../src/server/security.mjs), [identity.mjs](../../src/server/identity.mjs). Browser: [auth.js](../../public/assets/js/auth.js), [auth-providers.js](../../public/assets/js/auth-providers.js). Mobile: [08-mobile-app.md](08-mobile-app.md).

## Sign-in methods

| Method | Proof of email | Notes |
| --- | --- | --- |
| Email + password | Verification link (24 h) or an accepted invitation | scrypt hash; 10–128 characters |
| Google (web: Google Identity Services; mobile: native SDK) | Google's `email_verified` must be true | Audiences: `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_IDS` (web, Android, iOS client ids) |
| Apple (web and iOS; Android through a relay) | Apple sends the email only on first authorisation | Audiences: `APPLE_CLIENT_ID` + `APPLE_CLIENT_IDS`; currently not configured |
| TOTP second factor (optional) | — | RFC 6238, 6 digits, 30 s, ±1 step, each step accepted once; 10 single-use recovery codes |

## Lifetimes

| Item | Lifetime | Storage |
| --- | --- | --- |
| Access token | 1 hour | `sessions/{sha256}` |
| Refresh token | 30 days, single use | `refresh_tokens/{sha256}` (kept after use to detect reuse) |
| Session family ("device") | 90 days absolute | `user_sessions/{ses_…}` |
| Email verification link | 24 hours | `email_verifications/{sha256}` |
| Password reset link | 1 hour | `password_resets/{sha256}` |
| MFA challenge after password/Google | 5 minutes | `mfa_challenges/{sha256}` |
| MFA lockout | 15 minutes after 5 wrong codes | on the user document |
| "Recent sign-in" for re-authentication without a password | 15 minutes | session family `created_at` |

Every expiring record also gets an `expire_at` timestamp, so Firestore's TTL policy deletes it.

## Email sign-up and verification

```mermaid
sequenceDiagram
  autonumber
  actor U as Person
  participant W as /signup/ page
  participant API as Node API
  participant FS as Firestore
  participant M as Gmail SMTP

  U->>W: name, email, password, accept terms
  W->>API: POST /auth/signup {invite_token?}
  API->>API: validate every field (400 with details[])
  API->>FS: find user by email
  alt email already registered
    API->>M: "You already have an account" (or a new verification link)
    API-->>W: 201 {verification_required: true}  (same answer: no account probing)
  else new account with a matching invitation
    API->>FS: create user (email_verified = true), accept invite, create membership
    API-->>W: 201 {verification_required: false}
    W->>U: go to /login/?notice=account-ready
  else new account
    API->>FS: create user (email_verified = false)
    API->>FS: email_verifications/{sha256(token)} (24 h)
    API->>M: verification link /verify-email/?token=…
    API-->>W: 201 {verification_required: true}
    U->>W: opens link
    W->>API: POST /auth/verify-email {token}
    API->>FS: consume token (transaction, single use)
    API->>FS: users.email_verified = true
  end
```

Sign-in with an unverified address answers `403 EMAIL_NOT_VERIFIED`; the login page then requests a new link automatically.

## Password sign-in with a second factor

```mermaid
sequenceDiagram
  autonumber
  actor U as User
  participant W as /login/ page
  participant API as Node API
  participant FS as Firestore

  W->>API: POST /auth/login {email, password}
  API->>API: limits: 10 / 15 min per IP and per email
  API->>FS: find user
  alt unknown email
    API->>API: hash a dummy password (same timing)
    API-->>W: 401 INVALID_CREDENTIALS
  else wrong password
    API-->>W: 401 INVALID_CREDENTIALS (identical message)
  else status is not active
    API-->>W: 403 ACCOUNT_DISABLED
  else MFA enabled
    API->>FS: mfa_challenges/{sha256(mfa_token)} (5 min)
    API-->>W: 200 {mfa_required: true, mfa_token}
    U->>W: 6-digit code or recovery code
    W->>API: POST /auth/mfa/verify {mfa_token, code}
    alt code wrong
      API->>FS: failures + 1 (5th failure → locked 15 min)
      API-->>W: 401 INVALID_CODE or 429 MFA_LOCKED
    else code right (and not already used in this 30 s step)
      API->>FS: consume challenge, store last_step
      API->>FS: create session family + tokens
      API-->>W: 200 {access_token, user} + Set-Cookie sgsai_refresh (HttpOnly, Secure, SameSite=Strict, Path=/api/v1/auth)
    end
  else no MFA
    API->>FS: create session family + tokens
    API-->>W: 200 {access_token, user} + refresh cookie
  end
```

## Google sign-in (web)

```mermaid
sequenceDiagram
  autonumber
  actor U as User
  participant W as /login/ page
  participant G as Google Identity Services
  participant API as Node API
  participant FS as Firestore

  W->>API: GET /api/config
  API-->>W: {googleClientId}
  W->>G: render button / One Tap (origin must be an Authorized JavaScript origin)
  U->>G: choose account
  G-->>W: ID token (JWT, nonce)
  W->>API: POST /auth/google {id_token, nonce}
  API->>G: verify signature, issuer, audience, expiry, nonce
  alt not configured / invalid
    API-->>W: 503 PROVIDER_NOT_CONFIGURED / 401 INVALID_CREDENTIAL
  else email not verified by Google
    API-->>W: 403 EMAIL_NOT_VERIFIED
  end
  API->>FS: find by google_sub, else by email
  opt matched an UNVERIFIED password account by email
    API->>FS: discard its password, MFA and sessions (takeover protection)
  end
  API->>FS: create or update user, link google_sub
  opt email is in ADMIN_EMAILS and verified
    API->>FS: role = admin
  end
  API-->>W: tokens (or MFA challenge if 2FA is on)
```

Account linking (`POST /auth/google/link`) attaches Google to an existing signed-in account and refuses a Google account already linked elsewhere (`409`). Unlinking is refused if Google is the only sign-in method (`409 LAST_SIGN_IN_METHOD`).

## Refresh rotation and theft detection

```mermaid
sequenceDiagram
  autonumber
  participant C as Client (web or mobile)
  participant API as Node API
  participant FS as Firestore

  Note over C: access token expired → API answers 401
  C->>API: POST /auth/token/refresh (web: cookie, mobile: {refresh_token})
  API->>FS: transaction on refresh_tokens/{sha256(token)}
  alt unknown or expired
    API-->>C: 401 → sign in again
  else first use
    API->>FS: mark used_at (kept until expiry)
    API->>FS: new access + refresh token in the same family
    API-->>C: 200 new tokens (web: new cookie)
  else already used (replay)
    API->>FS: revoke the whole session family
    API-->>C: 401 (the legitimate holder is signed out too)
  end
```

Web clients never see the refresh token. Mobile clients send `X-Client: mobile` and `X-Client-Platform: android|ios`, receive `refresh_token` in JSON, store it in the keystore/keychain, and refresh one request at a time.

## Sessions page, sign-out and password changes

| Action | Effect |
| --- | --- |
| `GET /auth/sessions` | One row per family: device (Browser / Android app / iOS app), user agent, started, last used |
| `DELETE /auth/sessions/{id}` | Revokes that family's access and refresh tokens immediately |
| `POST /auth/logout` | Revokes the current family and clears the cookie |
| `POST /auth/logout-all` | Revokes every family |
| Password change | Keeps this session, revokes the others |
| Password reset | Revokes all sessions; requires a TOTP or recovery code if 2FA is on; also marks the email verified |
| Admin disables an account | Revokes all sessions; sign-in answers `ACCOUNT_DISABLED` |

## Re-authentication for destructive actions

Disabling 2FA and deleting the account require one of: the password, a current TOTP code, or (for Google/Apple-only accounts without 2FA) a sign-in within the last 15 minutes. Wrong codes count towards the same 5-attempt lockout as sign-in (fixed after the Copilot review of #78).

```mermaid
flowchart TD
  A[Destructive request] --> B{password given?}
  B -- yes --> C{matches?}
  C -- yes --> OK[allowed]
  C -- no --> F[403 REAUTH_FAILED]
  B -- no --> D{TOTP code given?}
  D -- yes --> E{2FA enabled and code valid?}
  E -- yes --> OK
  E -- no --> G[record failure → may lock] --> F
  D -- no --> H{no password, no 2FA,<br/>signed in < 15 min ago?}
  H -- yes --> OK
  H -- no --> R[403 REAUTH_REQUIRED]
```

Account deletion anonymises the user (email `deleted+{id}@invalid`, name "Deleted user"), removes memberships and sessions, and keeps the id so audit history stays consistent. The last owner of a workspace must transfer ownership first.

## Sign in with Apple on Android

Apple has no native Android SDK, so the app uses Apple's web flow and the API relays the result back into the app.

```mermaid
sequenceDiagram
  autonumber
  participant App as Android app
  participant API as Node API
  participant AP as appleid.apple.com

  App->>API: POST /auth/apple/android-state {package}
  API-->>App: signed state (HMAC, 10 min, package must be in APPLE_ANDROID_PACKAGES)
  App->>AP: web authorisation (Custom Tab) with state
  AP->>API: form_post /auth/apple/callback {id_token, code, state}
  API->>API: verify state signature and package
  API-->>App: 303 to intent://callback (package and scheme signinwithapple)
  App->>API: POST /auth/apple {id_token}
  API-->>App: tokens
```

## Account status

```mermaid
stateDiagram-v2
  [*] --> active: sign-up, admin invite, provider sign-in
  active --> disabled: admin disables (sessions revoked)
  disabled --> active: admin re-enables
  active --> deleted: user or admin deletes (anonymised)
  deleted --> [*]
  note right of active
    Accounts created before #78 had no status field;
    reads treat a missing status as active (#80).
  end note
```
