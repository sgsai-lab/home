# GitHub CRM integration

The GitHub CRM connects one SGS project to one GitHub organization repository and one organization Project v2 board. It reads issues, pull requests, status fields, and sprint iterations from that board; issuer operators can create issues and update Project v2 status/iteration fields. It does not import or combine boards across projects or tenants.

This feature is **not live until a GitHub App, its organization installation, webhook, OIDC caller, and Firestore indexes are provisioned**. Missing App credentials, unsupported permissions, and failed GitHub API calls are reported as unavailable; the service does not return simulated GitHub data. GitHub App secrets are not present in this repository.

## Route registration and dependency injection

`src/server/routes/github-crm.mjs` exports:

```js
createGithubCrmRoutes({
  env,
  adapter,                 // optional fake or custom GitHub App adapter
  verifyServiceIdentity    // optional (idToken, audience) => verified OIDC claims
})
```

Server integration imports `createGithubCrmRoutes` and adds its returned route tuples to the `/api/v1` router. Build the route table inside `createRequestHandler` so injected dependencies remain per handler:

```js
const routes = [
  ...existingRoutes,
  ...createGithubCrmRoutes({
    env,
    adapter: githubAdapter,
    verifyServiceIdentity: verifyGithubWorkerIdentity
  })
];
const router = createRouter(routes);
```

The handler options should expose `githubAdapter` and `verifyGithubWorkerIdentity`. Omitted adapter/verifier values use `createGithubAppAdapter(env)` and the default Google ID-token verifier. No `createContext` change is required: the webhook route reads `ctx.request` as raw bytes with a 512 KiB limit. All paths are under `/api/v1`, so they use the existing API proxy.

`src/server/github-crm.mjs` also exports `verifyCrmWorker(ctx, { env, verifyServiceIdentity })` for other durable job workers. It validates the Bearer OIDC token, configured audience, verified email claim, and the exact configured service-account email. Missing `GITHUB_CRM_WORKER_AUDIENCE` or `GITHUB_CRM_WORKER_SERVICE_ACCOUNT` fails closed with 503.

## API

All responses are `Cache-Control: no-store`; authenticated routes use the normal API bearer session and error envelope.

| Method and path | Purpose |
| --- | --- |
| `GET /api/v1/projects/:project_id/github-crm` | Owner-only view of the binding and latest bounded snapshot. |
| `PUT /api/v1/projects/:project_id/github-crm/binding` | Owner plus active issuer operator binds `repository_url` and `project_url`. |
| `POST /api/v1/projects/:project_id/github-crm/sync` | Owner plus issuer performs one bounded Project v2 read and saves the snapshot. |
| `POST /api/v1/projects/:project_id/github-crm/commands` | Owner plus issuer queues and executes an idempotent command. |
| `POST /api/v1/projects/:project_id/github-crm/commands/:command_id/retry` | Explicitly retries a failed or ambiguous command as an owner plus issuer. |
| `POST /api/v1/github-crm/webhooks` | Verifies GitHub's raw-body HMAC and inserts one durable inbox record per delivery ID. |
| `POST /api/v1/github-crm/worker/reconcile` | OIDC worker; body is `{ "project_id": "..." }`. Reconciles at most 10 commands and processes at most 10 matching deliveries for this one project. |

Binding links must be exact canonical HTTPS URLs with no path suffix, query, fragment, credentials, or non-GitHub host:

- Repository: `https://github.com/{organization}/{repository}`
- Organization Project v2 board: `https://github.com/orgs/{organization}/projects/{number}`

The owner names must match. Binding verification checks the selected repository's GitHub App installation and repository identity, scopes the minted installation token to that repository, then resolves the organization board through GraphQL. A repository binding cannot point at a user account or a board in another organization.

Command bodies are restricted to:

```json
{ "type": "issue.create", "title": "Short title", "body": "Optional description" }
{ "type": "issue.status", "item_id": "Project item node ID", "field_id": "Status field ID", "option_id": "Status option ID" }
{ "type": "issue.iteration", "item_id": "Project item node ID", "field_id": "Iteration field ID", "iteration_id": "Iteration ID" }
```

Commands require an `Idempotency-Key` of 1–120 ASCII letters, digits, `_`, or `-`. The same key and body return the original command; reusing the key with a different body returns 409. Command status is one of `pending`, `completed`, `failed`, or `reconciliation_required`. Execution and reconciliation each use a transactional lease and attempt ID; final writes compare the active attempt so a stale request or worker cannot overwrite a newer result. The worker only claims pending attempts whose execution lease expired and whose start is at least five minutes old. A lost response or GitHub 5xx can be ambiguous: the system does not silently send a duplicate create request. Issue creates include a command marker, and the worker searches for that marker before reconciling. A failed/ambiguous command requires an explicit authenticated retry. GitHub status/iteration updates are idempotent but are not automatically retried.

The browser retains its original idempotency key after a lost response and after an idempotency conflict. Editing that form's payload during ambiguity does not silently allocate a new key: restore the original payload to recover its command result, or inspect/reconcile the GitHub outcome before deliberately starting a different operation.

Project reads are bounded to the first 100 board items. Snapshots expose `items_truncated` and `items_page_info` (`has_next_page`, `end_cursor`); the browser displays an incomplete-snapshot notice and directs users to the GitHub board when more items exist. The cursor is informational; this API does not fetch later pages.

## Authorization and persistence

Every user-facing route calls `financeProject` / `financeAccess`; only an active actual workspace owner can access the project, and SGS admin role does not bypass membership. Mutations call `commitFinance`, which revalidates the active user, actual owner membership, issuer operator assignment, project, and tenant in the same Firestore transaction. The issuer must be an active SGS admin with an active `issuer_operators` record. The worker uses `transactDocs` to recheck the original command actor's active owner/issuer state before command reconciliation.

| Collection | Document ID | Content |
| --- | --- | --- |
| `github_project_bindings` | project ID | Tenant/project IDs, repository and organization Project v2 IDs/URLs, verified installation ID; never an App key or token. |
| `github_project_snapshots` | project ID | Latest bounded normalized items, iterations, status options, project metadata, and sync time. |
| `github_crm_commands` | `gcmd_` + SHA-256 of project/user/idempotency-key | Durable command state, sanitized request, actor, attempt count, external IDs and safe error code. |
| `github_webhook_inbox` | SHA-256 of GitHub delivery ID | Minimal verified delivery/event/action metadata, lowercase repository name, and processing state for durable deduplication; no raw payload or issue body. |

The worker's command query is `project_id == project.id` plus `status in [pending, reconciliation_required]`, with no explicit ordering, cursor, or pagination. Its composite Firestore index is:

- `github_crm_commands`: `project_id ASC`, `status ASC` (used with equality and `in` filters).
- `github_webhook_inbox`: `status ASC`, `repository ASC` (both equality filters).

The command index does not require `id ASC` because the worker does not use document-ID ordering or cursor paging. The inbox query scopes both pending status and lowercase repository before applying its 10-record limit, so unrelated repositories cannot consume that batch. Provision the new inbox index before future GitHub activation; GitHub remains disabled until its configuration/provisioning gates are satisfied. Existing mixed-case inbox repository names must be normalized before activation if any were retained from an earlier deployment. Other collections use document reads by ID. Keep the indexes and queries aligned if worker ordering/paging changes; do not broaden the worker query to import multiple project boards.

## GitHub App and deployment setup

### Organization-owner registration

An organization owner or authorized App manager must finish registration and installation in GitHub; the deployment workflow cannot invent an App ID or authorize its own installation. Follow [GitHub's registration guide](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app).

For an `sgsai-lab`-owned App, open [New GitHub App](https://github.com/organizations/sgsai-lab/settings/apps/new) while signed in with the appropriate organization permission:

- Suggested name: `SGS AI Project CRM` (choose another if unavailable); homepage `https://sgsaitechnology.com`.
- Webhook URL: `https://sgsaitechnology.com/api/v1/github-crm/webhooks`; keep SSL verification enabled. Set a high-entropy secret directly in GitHub and Secret Manager, never in chat or source.
- Use installation-token authentication, not an OAuth user sign-in flow. Configure the permissions/events below; add repository Pull requests **read** for PR views.
- Register, record the actual **App ID** (not Client ID), generate a PEM private key and store it directly in Secret Manager through an approved secret-management workflow. Do not commit/download it into the repository.
- Install on the selected customer organization/repositories and authorize its organization Project v2 access. In the website, an assigned issuer with actual workspace ownership binds the specific project to the canonical repository and board URLs.

Until credentials are deployed, the webhook endpoint reports unconfigured; do not treat failed pre-activation deliveries as successful. After activation verify delivery, and explicitly redeliver approved failed setup events where needed.

### Deployment wiring

The [activation checklist](deployment.md#activation-inputs-and-readiness) maps repository variables to the API environment below. Set `CRM_GITHUB_ENABLED=true` only when App ID, both Secret Manager names, worker audience/account, permissions, indexes and scheduling are ready. When false/unset, the workflow does not mount App credentials even if their names are recorded. Worker identity can be configured independently for finance recovery.

Configure these API container environment variables:

| Variable | Required for | Value |
| --- | --- | --- |
| `GITHUB_APP_ID` | App JWT and installation-token exchange | Numeric GitHub App ID. |
| `GITHUB_APP_PRIVATE_KEY` | App JWT | GitHub App PEM private key; preserve PEM newlines or use literal `\n`. Store as a Secret Manager-backed secret, never in source, logs, or `/api/config`. |
| `GITHUB_WEBHOOK_SECRET` | Webhook endpoint | High-entropy GitHub webhook secret, stored in Secret Manager. |
| `GITHUB_CRM_WORKER_AUDIENCE` | Worker endpoint | Exact audience configured on the worker's Google-signed OIDC ID token. |
| `GITHUB_CRM_WORKER_SERVICE_ACCOUNT` | Worker endpoint | Exact verified service-account email allowed to call the endpoint. |

Install the GitHub App on each selected organization and grant only the needed permissions:

- Repository metadata: read.
- Issues: read/write (create issues).
- Pull requests: read.
- Organization Projects: read/write (read Project v2, add newly created issues, update project fields).
- Subscribe the webhook to `issues`, `pull_request`, and Project v2 item changes as needed for refresh notifications.

The App JWT is RS256-signed and expires after 9 minutes. Installation tokens are requested for only the selected repository and cached in process only until shortly before their GitHub expiry; they are never returned to the browser or logged. GitHub requests use fixed `api.github.com` endpoints, disable redirects, and apply timeouts. User-supplied URLs are only parsed against the exact GitHub web-origin allowlist and are never fetched directly.

Provision a Cloud Run Job or another managed worker to call the reconcile endpoint with a Google-issued OIDC ID token and a single `project_id`. There are no in-process timers or post-response background tasks. Deploy a GitHub webhook URL at `/api/v1/github-crm/webhooks` and set its secret to the same secret used by the API. Apply the Firestore index above. Until all of these are provisioned and live credentials are injected, the CRM is unconfigured and cannot read or modify GitHub.
