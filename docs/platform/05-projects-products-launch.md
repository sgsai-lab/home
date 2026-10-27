# 5. Projects, products and launch links

Code: [routes/projects.mjs](../../src/server/routes/projects.mjs), [routes/products.mjs](../../src/server/routes/products.mjs), [validation.mjs](../../src/server/validation.mjs). Pages: `/workspace/`, `/workspace/project/?id=`, `/projects/`, `/workspace/launch/`, `/products/`.

## Projects

A project is one business engagement or education programme for a client. It carries the sector-specific details that make the hub useful for both kinds of work.

| Field | Business | Education |
| --- | --- | --- |
| `sector_profile` | `engagement_type` (advisory, build, managed service), `department` | `institution_type` (school, college, university, training), `programme`, `cohort`, `academic_year` |
| Milestone template (`use_template: true`) | Discovery, Proposal, Build, User acceptance testing, Handover | Needs analysis, Pilot cohort, Rollout, Term review |

Shared fields: name, summary, status, tags (≤ 20), start/end dates (end ≥ start), up to 20 milestones `{title, due, done}`, cover image, owner.

### Status lifecycle

```mermaid
stateDiagram-v2
  [*] --> draft
  draft --> discovery
  discovery --> in_progress
  in_progress --> on_hold
  on_hold --> in_progress
  in_progress --> delivered
  delivered --> archived
  draft --> archived
  note right of in_progress
    Any status can be set by a workspace admin;
    the arrows show the usual path.
  end note
```

Deleting is a **soft delete**: `deleted_at` is set, the project disappears for members, and admins can restore it for 30 days (`POST /projects/{id}/restore`). After that the Firestore TTL policy removes it.

### Concurrent edits (ETag / If-Match)

Two admins ticking milestones at the same time must not overwrite each other.

```mermaid
sequenceDiagram
  autonumber
  participant A as Admin A
  participant B as Admin B
  participant API as Node API
  participant FS as Firestore

  A->>API: GET /projects/p1
  API-->>A: 200, ETag "v4"
  B->>API: GET /projects/p1
  API-->>B: 200, ETag "v4"
  A->>API: PATCH milestones, If-Match "v4"
  API->>FS: transaction: version 4 = 4 → write, version 5
  API-->>A: 200, ETag "v5"
  B->>API: PATCH status, If-Match "v4"
  API->>FS: transaction: version 5 ≠ 4
  API-->>B: 412 PRECONDITION_FAILED
  B->>API: GET /projects/p1 (page reloads the latest)
```

## Products (apps and services)

| Field | Values / rule |
| --- | --- |
| `kind` | `pwa`, `web`, `service` (need `launch_url`), `android`, `ios` (need a store link or a launch URL) |
| `status` | `planned` (hidden from the launcher), `beta`, `live`, `retired` (link shows a "retired" page) |
| `visibility` | `client` (members only) or `public` (listed on `/products/`; SGS admins only) |
| `slug` | Globally unique, used in `/go/{slug}`; a clash returns `409 SLUG_TAKEN` with a suggestion |
| URLs | `https://` only, no credentials, ≤ 500 characters |
| `project_id` | Optional; must be a project of the same workspace |

## Launch links: `/go/{slug}`

One stable link per app, usable from the workspace, the mobile app, emails and QR codes.

```mermaid
flowchart TD
  G["GET /go/{slug}"] --> F{product exists?}
  F -- no --> NF[404 branded page]
  F -- yes --> RT{retired?}
  RT -- yes --> GONE[410 page with the client's contact email]
  RT -- no --> V{visibility}
  V -- public --> T[resolve target]
  V -- client --> TK{valid launch token for this app?}
  TK -- no --> L["302 /workspace/launch/?slug=…"]
  TK -- yes --> T
  T --> U{target}
  U -- launch_url --> EV
  U -- "store link for the source platform" --> EV
  U -- none --> NA[404 Not available yet]
  EV[record launch_event 180 days] --> RD["302 to target<br/>+ utm_source=sgsai_hub&utm_medium=web|android|ios|link"]
```

### Opening a client app from the workspace

```mermaid
sequenceDiagram
  autonumber
  actor U as Member
  participant W as /workspace/
  participant L as /workspace/launch/
  participant API as Node API
  participant FS as Firestore
  participant APP as Client app

  U->>W: click app tile (opens /go/learning-portal in a new tab)
  W->>API: GET /go/learning-portal (no token)
  API-->>L: 302 /workspace/launch/?slug=learning-portal
  L->>API: GET /products/by-slug/learning-portal (Bearer)
  alt not signed in
    L->>U: sign in, then come back
  else not a member
    API-->>L: 403 → "Ask your workspace administrator to invite you"
  end
  L->>API: POST /products/{id}/launch-token
  API->>FS: launch_tokens/{sha256} (60 s, single use, source=web)
  API-->>L: {path: /go/learning-portal?t=…&src=web}
  L->>API: GET /go/learning-portal?t=…
  API->>FS: consume token, write launch_event
  API-->>APP: 302 https://learn.client.example/…?utm_source=sgsai_hub&utm_medium=web
```

The mobile app requests the launch token itself (`X-Client-Platform` sets `source` to `android` or `ios`) and opens the returned URL in the browser; see [mobile app](08-mobile-app.md#launching-an-app).

Admins see launch counts per source for the last 30 days in the workspace console (`GET /products/{id}/launches`).

## Public catalog (`/products/`)

```mermaid
sequenceDiagram
  participant P as /products/ page
  participant N as Nginx (static)
  participant API as Node API

  par
    P->>N: GET /assets/data/catalog.json (SGS's own announced products)
  and
    P->>API: GET /api/v1/catalog (public apps, cached 5 min)
  end
  API-->>P: [{name, slug, summary, kind, status, icon_url, sector, launch_path}] (no tenant ids)
  P->>P: "Available now" = public apps not planned · "In development" = own + planned
  Note over P: If the API fails, the committed catalog.json still renders, with a notice
```

Only same-origin paths and `https://` URLs are rendered as links or images on this page.
