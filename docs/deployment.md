# Deployment and operations

## Supported deployment

Production uses the root [Dockerfile](../Dockerfile): Node.js builds `public/` into `dist/`, then an unprivileged Nginx container serves the result alongside the Node API. [Nginx configuration](../config/nginx.conf) listens on port 8080. The API listens on loopback port 3000.

Use [the GCP infrastructure guide](../infra/gcp/README.md) for Terraform, IAM, Secret Manager, GitHub variables, DNS, certificates, and Cloud Run provisioning. It is the infrastructure source of truth; do not create parallel resources using obsolete manual provisioning instructions.

A static host can serve `dist/` for previews, but cannot provide contact or account APIs by itself. Never publish the repository root. Firebase Hosting is not configured by this repository.

## Local release verification

Run from the repository root with Node.js 22 and Docker available:

```sh
npm ci
npm run lint
npm test
npm run build
npm run check:dist
npm run lighthouse
docker build -t sgs-ai-website:local .
bash scripts/check-container.sh sgs-ai-website:local
```

For static preview, run `npm run preview` and open <http://localhost:4173>. The preview has no API: account, workspace and catalog calls fail there. For same-origin integration, run the container. `FIRESTORE_DISABLED=true` runs the API on its in-memory store (data is lost on restart):

```sh
docker run --rm --name sgs-ai-website -p 8080:8080 \
  -e SMTP_HOST -e SMTP_PORT -e SMTP_SECURE -e SMTP_USER -e SMTP_PASS \
  -e CONTACT_FROM -e CONTACT_TO \
  -e GOOGLE_CLIENT_ID -e APPLE_CLIENT_ID -e GCP_PROJECT_ID \
  -e FIRESTORE_DISABLED=true -e ADMIN_EMAILS=you@example.com -e SITE_ORIGIN=http://localhost:8080 \
  sgs-ai-website:local
```

Open <http://localhost:8080>. Supply SMTP and cloud configuration only when intentionally testing those integrations. The container smoke test does not send mail or authenticate real users. Cloud integrations also require suitable runtime credentials and permissions; do not bake them into an image.

## Runtime configuration

SMTP settings and operational limitations are documented in [README.md](../README.md#contact-email-runtime-configuration). Inject credentials through Secret Manager in production.

- `GOOGLE_CLIENT_ID` and `APPLE_CLIENT_ID` are public provider identifiers exposed through `/api/config`. The API also uses them as the required token audience; sign-in with an unconfigured provider returns 503. See [Google sign-in](google-sign-in.md) for OAuth client and Firestore setup.
- `GCP_PROJECT_ID` identifies the project used by the persistence integration. Cloud Run should use its runtime service account for credentials.
- `API_UPSTREAM` defaults to `http://127.0.0.1:3000` for `/api/v1/`. Override only for an intentional alternate backend reachable from the container.
- `API_PORT` configures the standalone Node listener. Keep the container API on 3000 unless the Nginx configuration and startup readiness check are changed together.

### Client hub (ADR-002)

Set these as repository variables; the deploy workflow passes the non-empty ones to Cloud Run. Values containing `|` are rejected. Secrets are referenced by Secret Manager name and mounted with `--set-secrets`.

| Variable | Required for | Notes |
| --- | --- | --- |
| `SITE_ORIGIN` | Email links, launch URLs | Default `https://www.sgsaitechnology.com` |
| `ADMIN_EMAILS` | First SGS admin | Comma-separated; grants `admin` on the next verified sign-in |
| `GOOGLE_CLIENT_IDS` | Mobile Google sign-in | Extra audiences (Android, iOS) besides `GOOGLE_CLIENT_ID` |
| `APPLE_CLIENT_IDS` | Apple on iOS and Android | Extra audiences: iOS bundle id and the Apple Services ID |
| `APPLE_ANDROID_PACKAGES` | Apple on Android | Allowed Android packages for the callback relay |
| `APPLE_STATE_SECRET_SECRET` | Apple on Android | Secret Manager name of the HMAC key for the callback `state` |
| `MFA_ENCRYPTION_KEY_SECRET` | Two-factor authentication | Secret Manager name of a 32-byte base64 key (`openssl rand -base64 32`). Rotating it disables existing 2FA enrolments |
| `MEDIA_BUCKET` | Uploads, logos, deliverables | Private bucket (INF-12) |
| `PUBLIC_ASSETS_BUCKET` | Public product icons | Public-read bucket (INF-12) |
| `ANDROID_CERT_SHA256` | Android App Links | Comma-separated signing certificate fingerprints (Play App Signing and upload key) |
| `APPLE_TEAM_ID` | iOS Universal Links | 10-character team id |

Optional overrides read by the API: `ANDROID_APP_PACKAGES` and `IOS_BUNDLE_IDS` (default `com.sgsaitechnology.app`), `FIRESTORE_DATABASE` (non-default database, e.g. a restore), `FIRESTORE_DISABLED` and `ALLOW_MEMORY_DB_FALLBACK` (local development only; the image sets the fallback to `false`).

Features whose configuration is missing answer `503` (or `404` for the association files) instead of failing silently. See [the runbook](runbook-firestore-gcs.md) for Firestore and Cloud Storage operations and [the API reference](api.md) for endpoints.

## CI and release

### CRM activation and operations

Deals, approvals and draft finance workflows are already available to actual owners. The activation workflow defaults invoice issuance and GitHub integration to disabled, and pins voiding to disabled. Preparing or merging deployment wiring does not itself configure an App, approve invoices, create workers or grant access. Keep the activation PR in draft until the readiness checklist below is complete. Issuer and workspace-owner assignments are configured by the administrator in the website; deployment grants neither.

#### Activation inputs and readiness

Set the following GitHub repository variables only after the infrastructure owner and qualified reviewer confirm readiness. Values are configuration references, never private keys, webhook secrets or bank details.

| Repository variable | Purpose |
| --- | --- |
| `CRM_GITHUB_ENABLED` | Exact `true` to inject the App configuration; unset/`false` keeps it disabled |
| `CRM_GITHUB_APP_ID` | Numeric ID obtained after organization-owner App registration; passed as `GITHUB_APP_ID` |
| `CRM_GITHUB_APP_PRIVATE_KEY_SECRET` | Secret Manager **name** containing the App PEM key, mounted as `GITHUB_APP_PRIVATE_KEY` |
| `CRM_GITHUB_WEBHOOK_SECRET` | Secret Manager **name** containing the webhook secret, mounted as `GITHUB_WEBHOOK_SECRET` |
| `CRM_WORKER_AUDIENCE` | Exact HTTPS audience used by the managed worker's Google ID tokens; passed as `GITHUB_CRM_WORKER_AUDIENCE` |
| `CRM_WORKER_SERVICE_ACCOUNT` | Exact allowed worker service-account email; passed as `GITHUB_CRM_WORKER_SERVICE_ACCOUNT` |
| `CRM_INVOICE_ISSUANCE_ENABLED` | Exact `true` only after qualified approval; unset/`false` keeps issuance disabled |
| `CRM_INVOICE_APPROVAL_REFERENCE` | Nonblank qualified-review reference required by deployment when enabling issuance; not sent to the API/browser |

GitHub reserves the `GITHUB_` prefix for configuration-variable names, so repository inputs use `CRM_`; the workflow maps them to the existing runtime names. Secret mounts use `latest`, consistent with the existing SMTP/MFA mounts. Grant the Cloud Run runtime identity access to the named secrets and review the current versions before rollout. The workflow validates flags, required pairs, App ID and secret names before calling `gcloud run deploy`; it does not verify legal approval or provision resources. Each workspace still needs its own approved legal profile/reference in the website; the deployment reference does not replace that runtime check.

Before marking the activation PR ready:

- Organization owner registers/installs the [GitHub App](github-crm.md#organization-owner-registration), confirms selected-repository permissions, obtains the real App ID, and places its key/webhook secret directly in Secret Manager.
- Infrastructure owner confirms the finance, GitHub command and **`github_webhook_inbox(status, repository)`** indexes READY, runtime secret IAM, worker identity/OIDC, and per-project scheduling. The finance recovery caller must follow all `next_cursor` pages; a single static Scheduler request is not sufficient for a multi-page backlog.
- Administrator selects the website project and binds the actual repository/organization Project v2 board, with issuer assignment and actual workspace-owner membership verified. No pilot workspace/project/repository is assumed.
- Qualified reviewer approves real invoice/tax/e-invoicing/numbering/retention requirements, and the issuer records the actual approved workspace profiles. Do not enter example approvals or legal/bank data.
- Review the repository variables, then approve merge/deployment. Verify App sync/webhook delivery, service-authenticated worker calls and a reviewer-approved invoice pilot after rollout. No test issue, financial record or membership is created automatically.

Missing activation prerequisites are a release blocker, not permission to insert placeholders. The workflow owns the complete Cloud Run environment and secret mounts: disabling `CRM_GITHUB_ENABLED` removes App ID/key/webhook mounts on the next deployment, preserving other declared secrets; when no secret references are configured it explicitly clears mounts. To disable workers too, clear both worker variables. Disabling invoice issuance does not delete or renumber existing records. Voiding remains pinned `false` and requires a further reviewed legal change.

Deploy [Firestore indexes](../config/firestore/firestore.indexes.json) through the infrastructure owner before enabling CRM workloads. Keep the existing deny-all client rules and production memory fallback disabled. No infrastructure is provisioned automatically by the feature branch.

- Set `CRM_INVOICE_ISSUANCE_ENABLED=true` **only after** a qualified India GST reviewer approves the actual issuer, customer details, SAC/rates, numbering, required text, e-invoicing applicability and retention/legal holds. Configure the workspace billing profile with an approval reference. Test fixture legal/bank details are not real configuration.
- Issuer operators require an audited administrator assignment **and** actual customer workspace owner membership. Customer acceptance requires a non-administrator owner. Test operator revocation before the pilot.
- `CRM_INVOICE_VOID_ALLOWED=true` is a separate legal gate. Prefer credit notes where legally required; void never releases source claims or recycles a number.
- Configure App secrets/permissions and the service OIDC identity using [GitHub CRM setup](github-crm.md). Secrets must be mounted through Secret Manager; they never belong in the browser or `/api/config`.
- Provision an external scheduler/worker for each configured project's reconciliation and notification recovery. Call `POST /api/v1/github-crm/worker/reconcile` with `{project_id}` and `POST /api/v1/crm/finance-worker/retry` with `{project_id,cursor?}` using a Google-signed service ID token. Finance retries must follow every `next_cursor`. Audience/service account use `GITHUB_CRM_WORKER_AUDIENCE` and `GITHUB_CRM_WORKER_SERVICE_ACCOUNT`; user tokens are rejected. There are no in-process timers.
- Monthly invoice creation is intentionally reviewed, not scheduled automatic charging: close the month, review eligible approved sources, draft in batches, issue and notify.
- Until the finance-worker scheduler is provisioned, failed notifications do not recover automatically. Use the explicit Notify command to retry after reviewing delivery state; mail is at-least-once and may duplicate after partial delivery.
- Monitor `finance_jobs` failures/exhausted attempts, `delivery_state`, GitHub command ambiguity, webhook lag and service responses. Mail is at-least-once: a process crash after provider acceptance may cause a duplicate minimal notification. Do not silently repeat ambiguous external mutations.
- PDF creation occurs after financial commit; failure does not roll back an issued number. Replay the original command or retry owner download to archive the immutable snapshot. The private document is then served byte-for-byte, never regenerated by subsequent deployment. Archive size is capped at 600 KB; renderer v1 explicitly rejects unsupported non-Latin text before issuing.
- Back up financial collections/documents together. Restrict operational DB access, approve retention and test restoration/reconciliation before real money. Do not restore an older application that bypasses owner checks or purges retained projects.
- The deploy workflow passes the activation variables and Secret Manager references above; it does not provision App registration, secrets, scheduler jobs, indexes or IAM policies. The infrastructure owner must supply them through the supported infrastructure deployment before activation. Keep flags disabled until that rollout is verified.

Read [finance API](api.md#project-finance) for correction/retry contracts. Roll back by disabling issuance and new GitHub commands, not deleting records, invoice numbers or financial claims.

[Website CI](../.github/workflows/ci.yml) is the single pull-request workflow. Its `validate-and-build` job installs locked dependencies, runs lint and tests, builds the site, checks built links, enforces the Lighthouse budgets (mobile, median of three runs, every category ≥ 90; reports are uploaded as the `lighthouse-reports` artifact), and builds and smoke-tests the image. Its `review` and `publish-review` jobs run the [automatic Copilot PR review](copilot-review.md) on eligible pull requests.

Shared steps live in composite actions under [.github/actions/](../.github/actions/): `setup` (pinned Node.js from `.nvmrc`, npm cache, and a `node_modules` cache keyed on `package-lock.json` so repeat runs skip `npm ci`; optionally a cached Copilot CLI) and `container-check` (image build plus `scripts/check-container.sh`). Change workflow setup in those actions rather than in individual workflows.

[Production deployment](../.github/workflows/deploy.yml) builds a commit-SHA-tagged image, runs the container smoke test, authenticates through Workload Identity Federation, pushes to Artifact Registry, and deploys Cloud Run through the `production` environment. It runs on pushes to `main` only when files that make up the image or its rollout change: `public/`, `src/`, `config/`, `scripts/build.mjs`, `package.json`, `package-lock.json`, `Dockerfile`, `.dockerignore`, or the deploy workflow itself. Pushes that touch only CI, docs, agents, skills, tests, or `infra/` do not redeploy. To redeploy `main` without a code change (for example after updating repository variables or Secret Manager values), run the workflow manually with **Run workflow**; manual runs from other branches are skipped. [test/deploy.test.mjs](../test/deploy.test.mjs) fails CI if the Dockerfile's shipped files, the build entry point, or its source directory are not covered by the `paths` list, so add new image inputs there when it fails. Shared composite actions and `scripts/check-container.sh` are intentionally excluded: they only gate the deploy, and CI exercises them on every pull request. Also restrict the `production` environment's deployment branches to `main` in repository settings; the workflow's `main` guard is defense in depth. Protect the default branch and require CI and production approval gates through repository settings. Deployment does not itself wait for the separate CI workflow; those protections are important.

Retain the last known-good image and revision. Review changes to Nginx, the Dockerfile, runtime configuration, and Terraform as operational changes, not just static content updates. Do not commit build output, credentials, Terraform state, saved plans, or local variable files.

## Post-deployment checks

Verify the homepage, nested routes, navigation, shared assets, branded 404 status, `/api/config`, `/api/readyz` (`database: firestore`), and that `curl -I` on a sub-page shows the CSP and `X-Frame-Options` headers. Exercise contact/account flows only with approved test data and configured providers. Check Cloud Run startup logs, revision health, HTTP errors, and latency. Confirm DNS and certificates using the infrastructure guide before directing new traffic.

The current Nginx content security policy and cache rules are preserved. Browser integrations must be checked under the actual container headers; a static preview alone cannot verify those policies.

## Rollback

Route traffic to the previously verified Cloud Run revision:

```sh
gcloud run services update-traffic sgs-ai-website \
  --region="$GCP_REGION" \
  --to-revisions=KNOWN_GOOD_REVISION=100
```

Verify the same page, asset, and API checks after rollback. Record the incident and add a focused regression check before the next release. Application rollback does not roll back persistent data or infrastructure changes.

## Troubleshooting

- Missing assets: confirm the resource is under `public/`, rebuild, and run `npm run check:dist`. Check browser network requests for module or CSS resource failures.
- API failures in preview: use the container for same-origin API integration; `npm run preview` is static-only.
- Container startup failure: inspect container or Cloud Run revision logs; confirm the API starts on 3000 and `API_UPSTREAM` resolves.
- Mail delivery failure: verify SMTP secrets, sender authorization, SPF/DKIM, and provider connectivity without exposing credentials in logs.
- Terraform changes: inspect the plan and preserve the existing state. Back up or migrate local state to a secured remote backend before team automation; never delete it as repository cleanup.