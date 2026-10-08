output "project_id" {
  description = "Configured Google Cloud project."
  value       = var.project_id
}

output "region" {
  description = "Cloud Run and Artifact Registry region."
  value       = var.region
}

output "artifact_registry_repository" {
  description = "Artifact Registry repository name used by the deployment workflow."
  value       = google_artifact_registry_repository.website.repository_id
}

output "runtime_service_account" {
  description = "Runtime service account email to set as GCP_RUNTIME_SERVICE_ACCOUNT."
  value       = google_service_account.runtime.email
}

output "github_deploy_service_account" {
  description = "Federated deploy account email to set as GCP_WIF_SERVICE_ACCOUNT."
  value       = google_service_account.github_deploy.email
}

output "github_wif_provider" {
  description = "Full provider resource to set as GCP_WIF_PROVIDER in GitHub repository variables."
  value       = google_iam_workload_identity_pool_provider.github.name
}

output "load_balancer_ip" {
  description = "Global IPv4 address for apex and www A records at the DNS provider."
  value       = google_compute_global_address.website.address
}

output "cloud_run_uri" {
  description = "Cloud Run service URI (ingress remains restricted to the external load balancer)."
  value       = google_cloud_run_v2_service.website.uri
}

output "smtp_secret_ids" {
  description = "Secret Manager IDs whose secret versions must be supplied outside Terraform."
  value = {
    username = google_secret_manager_secret.smtp_user.secret_id
    password = google_secret_manager_secret.smtp_pass.secret_id
  }
}
