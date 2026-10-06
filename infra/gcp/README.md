# GCP production deployment

This configuration provisions the Google Cloud resources needed for the existing GitHub Actions Cloud Run deployment and the custom domain `sgsaitechnology.com` (both apex and `www`). It uses project `home-509818` and region `asia-south1`, matching the deployment settings already used in this repository. Review `terraform.tfvars.example` before applying if those are not the intended project/domain values.

The architecture is:

```text
Squarespace DNS A records
        ↓
Google global IPv4 + external HTTPS load balancer
        ↓ HTTPS, with HTTP → HTTPS redirect
Cloud Run serverless NEG (asia-south1)
        ↓
sgs-ai-website (unprivileged Nginx + contact API)
```

The load balancer serves both `sgsaitechnology.com` and `www.sgsaitechnology.com` with Google-managed certificates. DNS remains hosted by Squarespace; Terraform does not edit registrar DNS. The certificates become active after both hostnames resolve to the reserved load-balancer address. Before cutover, `FAILED_NOT_VISIBLE` for the apex certificate and `PROVISIONING` for `www` are expected.

## Prerequisites

- Terraform 1.6+ and Google Cloud CLI installed.
- A Google Cloud project with billing enabled and permission to enable APIs, manage Cloud Run, Artifact Registry, Compute load balancing, service accounts/IAM, Secret Manager, and Workload Identity Federation.
- GitHub CLI authenticated to `sgsai-lab/home` if using the setup commands below.
- The authoritative DNS account for `sgsaitechnology.com` (currently Squarespace DNS).
- An SMTP provider and a verified sender before expecting the contact form to deliver email. SMTP credentials are never stored in this repository or in Terraform files/state.

## 1. Provision infrastructure

Authenticate to the intended GCP project and enable the Service Usage API (Terraform enables the remaining APIs):

```sh
gcloud auth login
gcloud config set project home-509818
gcloud services enable serviceusage.googleapis.com --project home-509818
gcloud auth application-default login
cd infra/gcp/terraform
cp terraform.tfvars.example terraform.tfvars
terraform init
terraform plan -out=tfplan
terraform apply tfplan
```

Read the plan before applying. It creates a Cloud Run bootstrap revision using Google's public hello container so the load balancer can be provisioned before the first GitHub deployment. On subsequent applies, Terraform deliberately ignores Cloud Run image and environment changes; GitHub Actions owns those fields. The Cloud Run service has deletion protection enabled; disable it explicitly in `main.tf` only for an approved teardown.

The repository, apex certificate, reserved IP, and Cloud Run serverless NEG already exist in project `home-509818`. After the partial apply, import any of them that are not already shown by `terraform state list`:

```sh
terraform import google_artifact_registry_repository.website projects/home-509818/locations/asia-south1/repositories/sgsai-images
terraform import google_compute_managed_ssl_certificate.website projects/home-509818/global/sslCertificates/sgsai-managed-cert
terraform import google_compute_global_address.website projects/home-509818/global/addresses/sgsai-global-ip
terraform import google_compute_region_network_endpoint_group.website projects/home-509818/regions/asia-south1/networkEndpointGroups/sgsai-cloudrun-neg
```

Do not re-import resources already shown by `terraform state list`. The existing certificate covers only the apex hostname, so Terraform keeps it and provisions a separate managed certificate for `www`; both are attached to the HTTPS proxy. Cloud Run ingress is restricted to the load balancer, and its invoker IAM check is disabled because this project organization blocks `allUsers` IAM members. This keeps `run.app` access restricted; do not broaden ingress to the public internet. Before another apply, run `terraform plan` and resolve any other resource-name conflicts by importing the named resource or updating the configuration. Terraform cannot adopt existing resources automatically.

Terraform state contains infrastructure metadata and must not be committed. The local state files are ignored by Git. For a team or CI-managed Terraform workflow, configure an access-controlled, versioned GCS backend before sharing or automating state.

## 2. Add GitHub repository variables

Terraform creates the GitHub OIDC provider restricted to `sgsai-lab/home` on `refs/heads/main`, along with a least-scope deploy identity. No service-account key is created. Set the non-secret repository variables required by `.github/workflows/deploy.yml` from Terraform outputs:

```sh
gh variable set GCP_PROJECT_ID --body "$(terraform output -raw project_id)"
gh variable set GCP_REGION --body "$(terraform output -raw region)"
gh variable set GCP_ARTIFACT_REPOSITORY --body "$(terraform output -raw artifact_registry_repository)"
gh variable set GCP_WIF_PROVIDER --body "$(terraform output -raw github_wif_provider)"
gh variable set GCP_WIF_SERVICE_ACCOUNT --body "$(terraform output -raw github_deploy_service_account)"
gh variable set GCP_RUNTIME_SERVICE_ACCOUNT --body "$(terraform output -raw runtime_service_account)"
```

To enable contact email delivery, create Secret Manager **versions** for the Terraform-created secrets `sgsai-smtp-user` and `sgsai-smtp-pass` using the selected provider's credentials, then add these repository variables:

- `SMTP_HOST`: SMTP server hostname.
- `CONTACT_FROM`: a sender address authorized by that SMTP provider.
- `SMTP_USER_SECRET`: `sgsai-smtp-user`.
- `SMTP_PASS_SECRET`: `sgsai-smtp-pass`.

Do not add secret values as GitHub variables, Terraform inputs, checked-in files, or command-line literals. Enter them through the Cloud Console's Secret Manager UI (or another approved secret-management workflow); the runtime identity receives access only to these two secrets. Enable sender-domain SPF/DKIM with the email provider. The deployment workflow works before SMTP is configured; it injects the two secret references only when both secret-name variables are set. Until a valid SMTP host, verified sender, and Secret Manager versions are configured, the contact form cannot deliver submissions and provides its email fallback.

Create a GitHub environment named `production` and configure required reviewers under repository Settings → Environments. Also protect `main` with pull-request review and required CI status checks; infrastructure cannot enforce the GitHub-side branch rule itself.

## 3. Deploy the website

After applying Terraform and setting the GitHub variables and production environment, merge the reviewed pull request to `main`. The deployment workflow uses GitHub OIDC, pushes a commit-SHA tag to Artifact Registry, then deploys it to Cloud Run with 0–5 instances and 256 MiB memory. Image vulnerability scanning is currently skipped because the Trivy installer fails in GitHub Actions. Wait for the workflow to succeed before changing public DNS; this keeps the existing site live until the actual website image is running behind the load balancer. The initial Terraform-created Cloud Run revision is only a bootstrap hello page.

## 4. Point DNS at the load balancer

Get the stable public IP:

```sh
terraform output -raw load_balancer_ip
```

At the authoritative DNS provider, configure:

| Name | Type | Value |
| --- | --- | --- |
| `@` / apex | `A` | Terraform `load_balancer_ip` output |
| `www` | `A` | Same Terraform `load_balancer_ip` output |

The existing apex A records for the previous website must be replaced during the planned cutover; remove conflicting `www` records as well. Preserve MX, SPF, DKIM, DMARC, and other non-web records. Do not add an AAAA record unless an IPv6 load-balancer frontend is provisioned too. DNS changes at Squarespace are intentionally manual and require its account access.

Google provisions the managed certificate after public DNS resolves both hostnames to this IP. Check progress with:

```sh
dig +short A sgsaitechnology.com
dig +short A www.sgsaitechnology.com
gcloud compute ssl-certificates describe sgsai-managed-cert \
  --global --project home-509818 \
  --format='yaml(managed.status,managed.domainStatus)'
```

Wait for `managed.status: ACTIVE` and `ACTIVE` status for both domains before relying on HTTPS; issuance and DNS propagation can take time. Test `https://sgsaitechnology.com` and `https://www.sgsaitechnology.com`. The port-80 frontend redirects to HTTPS.

## 5. Roll back

Rollback to a known-good Cloud Run revision:

```sh
gcloud run services update-traffic sgs-ai-website \
  --project home-509818 --region asia-south1 \
  --to-revisions=KNOWN_GOOD_REVISION=100
```

## Resources and cost

Terraform provisions the Artifact Registry Docker repository, runtime/deployer service accounts, GitHub OIDC pool/provider and IAM bindings, Secret Manager secret containers, Cloud Run service, serverless NEG, global backend/URL maps, Google-managed certificate, reserved IPv4, and HTTP/HTTPS forwarding rules. The global load balancer and reserved IP incur Google Cloud charges; check current pricing and quotas before applying. The SMTP secret containers contain no values until an operator adds secret versions.
