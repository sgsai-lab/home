# 8. Mobile app

Repository: `sgsai-lab/mobile-app` (Flutter, Android and iOS), branch `features/client-hub-launcher`, sgsai-lab/mobile-app#29 (open). Product brief and setup live in that repository; this page explains how the app fits the platform.

## Purpose

One app for client staff: sign in with the same SGS account as the website, choose a workspace, open the apps SGS AI built for them, follow projects and see the team. It does not replace the client apps; it launches them ([decision D3](02-decisions.md#d3-one-identity-system-for-web-and-mobile)).

## Structure

```mermaid
flowchart TB
  subgraph app["lib/app"]
    RT["router.dart<br/>go_router + pure redirect rules"]
    BOOT["bootstrap.dart<br/>flavor config, providers"]
  end
  subgraph core["lib/core"]
    TS["auth/token_store.dart<br/>flutter_secure_storage"]
    AI["network/auth_interceptor.dart<br/>QueuedInterceptor: bearer + refresh rotation"]
    CH["network/client_headers.dart<br/>X-Client: mobile, X-Client-Platform"]
    API["network/api_client.dart · api_exception.dart<br/>Dio, error envelope"]
    SC["storage/snapshot_cache.dart<br/>shared_preferences"]
    CONN["network/connectivity_provider.dart"]
  end
  subgraph features["lib/features"]
    AUTH["auth: sign-in screen, MFA step, controller"]
    WS["workspace: home (apps, projects, team),<br/>project detail, app launcher, /go/:slug screen"]
  end
  AUTH --> API
  WS --> API
  WS --> SC
  API --> AI --> TS
  API --> CH
  RT --> AUTH
  RT --> WS
```

| Route | Screen |
| --- | --- |
| `/startup` | Restores tokens, decides where to go |
| `/sign-in?from=` | Email + password, then a 6-digit code if 2FA is on |
| `/` | Workspace home: switcher, apps, projects, team |
| `/project/:projectId` | Milestones, linked apps, team |
| `/go/:slug` | Launch from a deep link |

Flavors: `dev`, `stg`, `prod` with custom schemes `sgsai-dev://`, `sgsai-stg://`, `sgsai://` and App Links / Universal Links on `www.sgsaitechnology.com/go/*`.

## Tokens on the device

```mermaid
sequenceDiagram
  autonumber
  participant UI as Screen
  participant I as AuthInterceptor (queued)
  participant TS as Secure storage
  participant API as home API

  UI->>I: GET /api/v1/clients/…
  I->>TS: read access token
  I->>API: request + Authorization + X-Client: mobile
  alt 200
    API-->>UI: data
  else 401
    API-->>I: 401
    I->>TS: tokens changed while waiting? (another request already refreshed)
    alt yes
      I->>API: retry with the new access token
    else no
      I->>API: POST /auth/token/refresh {refresh_token}
      alt 200
        API-->>I: new access + refresh token
        I->>TS: store both (old refresh token is now spent)
        I->>API: retry original request
      else 401 (expired or reused)
        I->>TS: clear
        I-->>UI: session expired → /sign-in
      end
    end
  end
```

Because the interceptor is queued, ten parallel 401s produce one refresh. Sending a spent refresh token twice would revoke the whole session family on the server ([D14](02-decisions.md#d14-session-families-and-refresh-token-rotation)).

## Launching an app

```mermaid
sequenceDiagram
  autonumber
  actor U as Member
  participant App as Mobile app
  participant API as home API
  participant OS as Browser / store app

  alt tap a tile in the workspace
    U->>App: tap "Learning Portal"
  else open a link https://www.sgsaitechnology.com/go/learning-portal
    U->>App: App Link / Universal Link → /go/learning-portal
    App->>API: GET /products/by-slug/learning-portal (checks membership)
  end
  alt app has a launch URL
    App->>API: POST /products/{id}/launch-token (X-Client-Platform: android|ios)
    API-->>App: {url: …/go/learning-portal?t=…&src=android}
    App->>OS: open url externally
    OS->>API: GET /go/learning-portal?t=… → launch_event, 302 + utm_medium=android
  else store-only app
    App->>OS: open the Play Store / App Store link
  end
```

A link opened while signed out goes to `/sign-in?from=/go/…` and continues after sign-in.

## Offline

The last successful workspace view is saved with `shared_preferences` (names, statuses and links only; no tokens, no signed URLs). Without a connection the app shows that snapshot with a banner; signing out clears it.

## Status

| Item | State |
| --- | --- |
| Sign-in on SGS tokens, MFA step, workspace, projects, team, launch, deep links, offline | Done in #29 (`make check`: format, analyze, OpenAPI check, 46 tests; Android debug build passes in CI) |
| CI | Fixed in #29: the workflow file was invalid since before this work, so no checks had ever run |
| Google and Apple sign-in buttons (#7) | Waiting for OAuth client ids and Apple signing |
| Verification on real devices (#24) | Needs Android and iOS devices |
| Push notifications (#27) | Not started |
| App Links / Universal Links | Need `ANDROID_CERT_SHA256` and `APPLE_TEAM_ID` on the website (association files return 404 until then) |
