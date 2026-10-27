# 4. Workspaces and access

Code: [routes/clients.mjs](../../src/server/routes/clients.mjs), [authz.mjs](../../src/server/authz.mjs), [routes/users.mjs](../../src/server/routes/users.mjs), [routes/audit.mjs](../../src/server/routes/audit.mjs). Pages: `/admin/` (SGS console), `/admin/clients/?id=` (workspace console), `/workspace/join/`.

## Model

```mermaid
erDiagram
  USERS ||--o{ MEMBERSHIPS : "has"
  CLIENTS ||--o{ MEMBERSHIPS : "has"
  CLIENTS ||--o{ INVITES : "sends"
  CLIENTS ||--o{ PROJECTS : "owns"
  CLIENTS ||--o{ PRODUCTS : "owns"
  PROJECTS |o--o{ PRODUCTS : "delivers"
  CLIENTS ||--o{ ASSETS : "owns"
  CLIENTS ||--o{ AUDIT_LOG : "records"

  USERS {
    string id PK "usr_…"
    string email "unique, lowercase"
    string role "user or admin"
    string status "active, disabled or deleted"
  }
  CLIENTS {
    string id PK "cli_…"
    string slug "unique"
    string primary_sector "business or education"
    string status "prospect, active, paused or closed"
  }
  MEMBERSHIPS {
    string id PK "client_id__user_id"
    string role "viewer, member, admin or owner"
    string status "active"
  }
  INVITES {
    string id PK "inv_…"
    string email
    string role
    string token_hash
    number expires_at "7 days"
  }
```

Memberships are a **top-level** collection with a deterministic id, so "my workspaces" is one equality query and "is this user a member?" is one document read.

## Who can do what

| Action | Viewer | Member | Admin | Owner | SGS admin |
| --- | :-: | :-: | :-: | :-: | :-: |
| See workspace, projects, apps, team, files | ✓ | ✓ | ✓ | ✓ | ✓ |
| Open apps (launch token) | ✓ | ✓ | ✓ | ✓ | ✓ |
| Edit workspace details, logo | | | ✓ | ✓ | ✓ |
| Change workspace status | | | | | ✓ |
| Create/edit/delete projects, upload files | | | ✓ | ✓ | ✓ |
| Create/edit apps | | | ✓ | ✓ | ✓ |
| Make an app public on sgsaitechnology.com | | | | | ✓ |
| Invite people, change roles (except owners) | | | ✓ | ✓ | ✓ |
| Make or change owners | | | | ✓ | ✓ |
| Add an existing account directly | | | | | ✓ |
| View the workspace activity log | | | | ✓ | ✓ |
| Create workspaces, manage all users | | | | | ✓ |
| Leave a workspace | ✓ | ✓ | ✓ | ✓ (not the last) | — |

## Tenant isolation

Every tenant document carries `client_id`. Handlers never trust a `client_id` from the request for authorisation; they load the document and check its own `client_id`.

```mermaid
flowchart TD
  R[Request for a tenant resource] --> L[Load the document by id]
  L --> X{exists?}
  X -- no --> NF[404 NOT_FOUND]
  X -- yes --> C[requireMembership user, doc.client_id, minRole]
  C --> AD{user.role = admin?}
  AD -- yes --> OWN[act as owner] --> OK[continue]
  AD -- no --> M{active membership?}
  M -- no --> NF
  M -- yes --> RK{role ≥ minRole?}
  RK -- no --> FB[403 FORBIDDEN<br/>member, but not allowed]
  RK -- yes --> OK
```

Non-members always get `404`, so an outsider cannot tell whether a workspace, project or file exists. Members with too low a role get `403` with a message naming the role they need. Lists are scoped by the caller's memberships (`client_id in [...]`, chunked by 30).

## Invitation flow

```mermaid
sequenceDiagram
  autonumber
  actor A as Workspace admin
  participant API as Node API
  participant FS as Firestore
  participant M as Gmail SMTP
  actor P as Invited person
  participant J as /workspace/join/

  A->>API: POST /clients/{id}/invites {email, role}
  API->>API: role check (only owners can invite owners), 10 invites/hour per workspace
  API->>FS: delete older pending invites for that email
  API->>FS: invites/{inv_…} with sha256(token), expires in 7 days
  API->>M: "You're invited to {client}" with /workspace/join/?token=…
  API-->>A: 201 {email_sent}
  P->>J: open link
  J->>API: GET /invites/preview?token=… (public, minimal)
  API-->>J: {client_name, role, email}
  alt has no account
    J->>P: Create my account → /signup/?invite=…
    P->>API: POST /auth/signup {invite_token}
    API->>FS: create verified user, accept invite, membership
  else signed in with the invited email
    P->>API: POST /invites/accept {token}
    API->>FS: transaction: claim invite (accepted_at)
    alt membership write fails
      API->>FS: release the claim so the person can retry
    end
    API->>FS: membership (never downgrades an existing higher role)
    API-->>J: {client} → /workspace/?client=…
  else signed in with a different email
    API-->>J: 403 INVITE_EMAIL_MISMATCH
  end
```

A used invitation answers `410 INVITE_CONSUMED`; an unknown or expired one `404 INVITE_INVALID`. Resending issues a new token, so the old link stops working.

## SGS administrators

```mermaid
flowchart LR
  E["ADMIN_EMAILS variable<br/>comma-separated"] --> S{verified sign-in<br/>with that email?}
  S -- yes --> R[users.role = admin<br/>on that sign-in]
  S -- no --> U[stays user]
  R --> C["/admin/ console:<br/>create workspaces, manage users,<br/>manage any workspace"]
  C --> P["Promote or demote other users<br/>Admin console → Users"]
```

- Bootstrap: the first admin comes from `ADMIN_EMAILS` (currently `huggi.vittal@sgsaitechnology.com`). Later admins can be promoted in the console.
- Admins cannot change their own role or status (`400 SELF_MODIFICATION`), so the last admin cannot lock themselves out.
- Creating a user from the console emails a set-password link valid for 24 hours.

## Workspace console (`/admin/clients/?id=`)

| Tab | What it does |
| --- | --- |
| Overview | Name, sector, contact, brand colour, status (SGS only), logo upload |
| People | Invite, resend, revoke; change roles; remove or leave |
| Apps | Add/edit apps, copy the `/go/` link, launch counts (30 days), icon upload, public visibility (SGS only) |
| Activity | Audit log for owners: who did what in the last 90 days |

## Audit log

`audit_log` records workspace administration: client created/updated, members added/removed/role changed, invites created/resent/revoked/accepted, projects and apps created/updated/deleted, files uploaded/deleted, user security events (MFA enabled/disabled, password changed, account deleted). Each entry has actor, action, target, client, request id, a hashed IP, and a small `diff`. Keys that look secret (`token`, `password`, `secret`, `code`, `hash`) are dropped before writing. Entries expire after 90 days. Owners see their workspace's log; SGS admins can query all.
