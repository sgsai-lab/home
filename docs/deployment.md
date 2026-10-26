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

For static preview, run `npm run preview` and open <http://localhost:4173>. Contact and account APIs are not implemented by this preview. For same-origin integration, run:

```sh
docker run --rm --name sgs-ai-website -p 8080:8080 \
  -e SMTP_HOST -e SMTP_PORT -e SMTP_SECURE -e SMTP_USER -e SMTP_PASS \
  -e CONTACT_FROM -e CONTACT_TO \
  -e GOOGLE_CLIENT_ID -e APPLE_CLIENT_ID -e GCP_PROJECT_ID \
  sgs-ai-website:local
```

Open <http://localhost:8080>. Supply SMTP and cloud configuration only when intentionally testing those integrations. The container smoke test does not send mail or authenticate real users. Cloud integrations also require suitable runtime credentials and permissions; do not bake them into an image.

## Runtime configuration

SMTP settings and operational limitations are documented in [README.md](../README.md#contact-email-runtime-configuration). Inject credentials through Secret Manager in production.

- `GOOGLE_CLIENT_ID` and `APPLE_CLIENT_ID` are public provider identifiers exposed through `/api/config`. The API also uses them as the required token audience; sign-in with an unconfigured provider returns 503. See [Google sign-in](google-sign-in.md) for OAuth client and Firestore setup.
- `GCP_PROJECT_ID` identifies the project used by the persistence integration. Cloud Run should use its runtime service account for credentials.
- `API_UPSTREAM` defaults to `http://127.0.0.1:3000` for `/api/v1/`. Override only for an intentional alternate backend reachable from the container.
- `API_PORT` configures the standalone Node listener. Keep the container API on 3000 unless the Nginx configuration and startup readiness check are changed together.

## CI and release

[Website CI](../.github/workflows/ci.yml) restores cached locked dependencies (installing only when `package-lock.json`, Node, or the runner changes), runs lint and tests, builds the site, checks built links, and builds and smoke-tests the image. Lighthouse budgets run locally with `npm run lighthouse`, not in CI.

[Production deployment](../.github/workflows/deploy.yml) builds a commit-SHA-tagged image, runs the container smoke test, authenticates through Workload Identity Federation, pushes to Artifact Registry, and deploys Cloud Run through the `production` environment. Both workflows build through the shared [build-site-image](../.github/actions/build-site-image/action.yml) action, which reuses Docker layers from the GitHub Actions cache. Protect the default branch and require CI and production approval gates through repository settings. Deployment does not itself wait for the separate CI workflow; those protections are important.

Retain the last known-good image and revision. Review changes to Nginx, the Dockerfile, runtime configuration, and Terraform as operational changes, not just static content updates. Do not commit build output, credentials, Terraform state, saved plans, or local variable files.

## Post-deployment checks

Verify the homepage, nested routes, navigation, shared assets, branded 404 status, and `/api/config`. Exercise contact/account flows only with approved test data and configured providers. Check Cloud Run startup logs, revision health, HTTP errors, and latency. Confirm DNS and certificates using the infrastructure guide before directing new traffic.

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