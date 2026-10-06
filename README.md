# SGS AI Technology website

Plain HTML, CSS, JavaScript, and a small Node.js contact-notification API served by unprivileged Nginx. Public pages use clean routes. The Docker image builds minified static assets; no external font or analytics service is loaded.

## Local development and checks

Use Node.js 22 or a compatible current LTS release.

```sh
npm ci
npm run lint
npm test
npm run build
```

To preview the built site, run `npm run preview` and open <http://localhost:4173>. The preview server does not implement the contact API. Without a configured API, the form displays a direct email fallback.

## Contact email runtime configuration

The contact and product-update forms POST to the same-origin `/api/contact` endpoint. The Node API validates and sanitizes fields, requires consent, uses a honeypot and per-process/IP throttles (10 requests per 15 minutes; Nginx also limits rapid requests to 10/minute), then emails the submission to `CONTACT_TO` or `hello@sgsaitechnology.com`. It does not store submissions in a database or subscribe visitors to an automated mailing list.

Configure these variables only in the server/Cloud Run secret configuration:

| Variable | Required | Purpose |
| --- | --- | --- |
| `SMTP_HOST` | Yes | SMTP provider hostname |
| `SMTP_PORT` | No (587 default) | SMTP port |
| `SMTP_SECURE` | No | Set `true` for implicit TLS; port 465 also enables it |
| `SMTP_USER` | Yes | SMTP authentication username; inject as a secret |
| `SMTP_PASS` | Yes | SMTP authentication password; inject as a secret |
| `CONTACT_FROM` | Yes | Sender address accepted by the configured provider/domain |
| `CONTACT_TO` | No | Recipient; defaults to `hello@sgsaitechnology.com` |

Configure SPF/DKIM and an authorized sender with the email provider. No SMTP credentials, sender verification, or mail service are available in this repository, so live delivery remains disabled until the operator supplies these values. If mail delivery is unavailable, the form reports an error and offers a `mailto:` fallback. Rate limits are in-memory and per container instance; use an edge/WAF or shared limiter if a distributed abuse guarantee is required.

## Container

Build and run locally:

```sh
docker build -t sgs-ai-website:local .
docker run --rm --name sgs-ai-website -p 8080:8080 \
  -e SMTP_HOST -e SMTP_PORT -e SMTP_SECURE -e SMTP_USER -e SMTP_PASS \
  -e CONTACT_FROM -e CONTACT_TO sgs-ai-website:local
```

Open <http://localhost:8080>. Nginx returns a real 404 status with the branded page, compresses responses with gzip, caches static assets for an hour and HTML briefly, and proxies only the API to the local Node process. The stock Alpine Nginx image does not include Brotli; gzip is enabled. The supplied logo remains a large PNG; no optimized source asset was supplied and binary conversion was not performed here.

## GitHub Actions, Artifact Registry, and Cloud Run

The PR workflow runs HTML/CSS/JavaScript checks, local-link validation, API tests, a minified build, Lighthouse CI category budgets, and a Trivy scan that fails on fixable HIGH/CRITICAL image vulnerabilities. The `main` deployment workflow builds and scans the image, then pushes a tag equal to the full commit SHA and deploys that image to Cloud Run with 0–5 instances and 256 MiB memory. It uses Workload Identity Federation (WIF); no service-account key is stored in GitHub.

Before enabling deployment, an administrator must create the Artifact Registry repository, Cloud Run service/runtime identity, SMTP secrets, and a WIF provider/service account with least-privilege access. The workflow expects these **repository variables** (not secrets):

| Variable | Example format / use |
| --- | --- |
| `GCP_PROJECT_ID` | Project ID; not supplied as workflow configuration |
| `GCP_REGION` | Cloud Run and Artifact Registry region, e.g. `asia-south1` |
| `GCP_ARTIFACT_REPOSITORY` | Existing Docker repository name |
| `GCP_WIF_PROVIDER` | Full `projects/PROJECT_NUMBER/locations/global/workloadIdentityPools/POOL/providers/PROVIDER` resource name |
| `GCP_WIF_SERVICE_ACCOUNT` | Dedicated deployment service-account email |
| `GCP_RUNTIME_SERVICE_ACCOUNT` | Cloud Run runtime service-account email with access to SMTP secrets |
| `SMTP_HOST` | SMTP hostname (not a credential) |
| `CONTACT_FROM` | Verified sender address |
| `SMTP_USER_SECRET` | Secret Manager secret name containing SMTP username |
| `SMTP_PASS_SECRET` | Secret Manager secret name containing SMTP password |

The deployment identity needs only Artifact Registry write, Cloud Run deploy, and service-account act-as permissions. The runtime identity needs access to the two named Secret Manager secrets. External infrastructure prerequisites tracked as INF-05 and INF-07, project identifiers, WIF setup, and email credentials are not inferred or fabricated here. Add the `production` GitHub environment and configure required reviewers before relying on an approval gate.

### Rollback

Find the last known-good revision in Cloud Run, then route all traffic to it with one command (substitute its revision name):

```sh
gcloud run services update-traffic sgs-ai-website --region="$GCP_REGION" --to-revisions=KNOWN_GOOD_REVISION=100
```

## Required owner actions (not enforceable from repository files)

- Protect the actual default branch; require pull requests, appropriate reviewers, the CI check, and up-to-date branches.
- Add a verified owner/team to `.github/CODEOWNERS`; the repository does not identify an authorized team, so no person/team is guessed here.
- Require 2FA for organization/repository members and enable secret scanning plus push protection where eligible.
- Enable Dependabot security updates and review its generated PRs (the checked-in Dependabot file only configures version updates).
- Create the GitHub `production` environment, add approved production reviewers, and scope deployment variables/permissions appropriately.
- Configure WIF trust conditions to this exact repository and `main` branch, review granted GCP IAM roles, and complete external INF-05/INF-07 prerequisites.
- Set actual SMTP secrets in Secret Manager, grant the runtime identity access, and verify domain sender authentication.
- This source change applies only to this repository; it does not change security settings on any other repositories.

## Legal and analytics notes

The site sends page paths for public-page views to a first-party endpoint. Cloud Run application logs record only the allowed page path and event timestamp; the website analytics event does not retain visitor IP addresses, query strings, referrers, user agents, cookies, or visitor IDs. Hosting/network logs may separately process request metadata, and retention depends on the provider/configuration. No analytics cookies are set. Verified legal-entity, address, and founder/team details are not available and are intentionally not invented.