locals {
  service_name = "sgs-ai-website"
  domains      = [var.apex_domain, var.www_domain]
  required_apis = toset([
    "artifactregistry.googleapis.com",
    "compute.googleapis.com",
    "iam.googleapis.com",
    "iamcredentials.googleapis.com",
    "run.googleapis.com",
    "secretmanager.googleapis.com",
    "serviceusage.googleapis.com",
    "sts.googleapis.com",
  ])
}

resource "google_project_service" "required" {
  for_each           = local.required_apis
  project            = var.project_id
  service            = each.value
  disable_on_destroy = false
}

resource "google_artifact_registry_repository" "website" {
  project       = var.project_id
  location      = var.region
  repository_id = "sgsai-images"
  description   = "Container images for the SGS AI Technology website."
  format        = "DOCKER"

  depends_on = [google_project_service.required]
}

resource "google_service_account" "runtime" {
  project      = var.project_id
  account_id   = "sgs-ai-website-runtime"
  display_name = "SGS AI website Cloud Run runtime"
  description  = "Runtime identity for the public website and contact API."

  depends_on = [google_project_service.required]
}

resource "google_secret_manager_secret" "smtp_user" {
  project   = var.project_id
  secret_id = "sgsai-smtp-user"
  replication {
    auto {}
  }

  depends_on = [google_project_service.required]
}

resource "google_secret_manager_secret" "smtp_pass" {
  project   = var.project_id
  secret_id = "sgsai-smtp-pass"
  replication {
    auto {}
  }

  depends_on = [google_project_service.required]
}

resource "google_secret_manager_secret_iam_member" "runtime_smtp_user" {
  project   = var.project_id
  secret_id = google_secret_manager_secret.smtp_user.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.runtime.email}"
}

resource "google_secret_manager_secret_iam_member" "runtime_smtp_pass" {
  project   = var.project_id
  secret_id = google_secret_manager_secret.smtp_pass.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.runtime.email}"
}

resource "google_cloud_run_v2_service" "website" {
  project              = var.project_id
  name                 = local.service_name
  location             = var.region
  ingress              = "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER"
  invoker_iam_disabled = true
  deletion_protection  = true

  template {
    service_account = google_service_account.runtime.email

    scaling {
      min_instance_count = 0
      max_instance_count = 5
    }

    containers {
      # Bootstrap revision; GitHub Actions replaces this image on each main deployment.
      image = "us-docker.pkg.dev/cloudrun/container/hello"

      ports {
        container_port = 8080
      }

      resources {
        cpu_idle = true

        limits = {
          cpu    = "1"
          memory = "256Mi"
        }
      }

    }
  }

  # Container image and mail configuration are owned by the GitHub Actions deploy workflow.
  lifecycle {
    ignore_changes = [
      scaling,
      template[0].containers[0].image,
      template[0].containers[0].env,
    ]
  }

  depends_on = [google_project_service.required]
}

resource "google_compute_region_network_endpoint_group" "website" {
  project               = var.project_id
  name                  = "sgsai-cloudrun-neg"
  region                = var.region
  network_endpoint_type = "SERVERLESS"

  cloud_run {
    service = google_cloud_run_v2_service.website.name
  }
}

resource "google_compute_backend_service" "website" {
  project               = var.project_id
  name                  = "sgsai-backend"
  load_balancing_scheme = "EXTERNAL_MANAGED"
  protocol              = "HTTP"
  timeout_sec           = 30

  backend {
    group = google_compute_region_network_endpoint_group.website.id
  }
}

resource "google_compute_url_map" "https" {
  project         = var.project_id
  name            = "sgsai-https-url-map"
  default_service = google_compute_backend_service.website.id

  host_rule {
    hosts        = local.domains
    path_matcher = "website"
  }

  path_matcher {
    name            = "website"
    default_service = google_compute_backend_service.website.id
  }
}

resource "google_compute_url_map" "http_redirect" {
  project = var.project_id
  name    = "sgsai-http-redirect"

  default_url_redirect {
    https_redirect         = true
    redirect_response_code = "MOVED_PERMANENTLY_DEFAULT"
    strip_query            = false
  }
}

resource "google_compute_managed_ssl_certificate" "website" {
  project = var.project_id
  name    = "sgsai-managed-cert"

  managed {
    domains = [var.apex_domain]
  }

  depends_on = [google_project_service.required]
}

resource "google_compute_managed_ssl_certificate" "www" {
  project = var.project_id
  name    = "sgsai-www-managed-cert"

  managed {
    domains = [var.www_domain]
  }

  depends_on = [google_project_service.required]
}

resource "google_compute_target_https_proxy" "website" {
  project = var.project_id
  name    = "sgsai-https-proxy"
  url_map = google_compute_url_map.https.id
  ssl_certificates = [
    google_compute_managed_ssl_certificate.website.id,
    google_compute_managed_ssl_certificate.www.id,
  ]
}

resource "google_compute_target_http_proxy" "redirect" {
  project = var.project_id
  name    = "sgsai-http-redirect-proxy"
  url_map = google_compute_url_map.http_redirect.id
}

resource "google_compute_global_address" "website" {
  project      = var.project_id
  name         = "sgsai-global-ip"
  address_type = "EXTERNAL"
  ip_version   = "IPV4"

  depends_on = [google_project_service.required]
}

resource "google_compute_global_forwarding_rule" "https" {
  project               = var.project_id
  name                  = "sgsai-https-forwarding-rule"
  load_balancing_scheme = "EXTERNAL_MANAGED"
  ip_protocol           = "TCP"
  port_range            = "443"
  target                = google_compute_target_https_proxy.website.id
  ip_address            = google_compute_global_address.website.id
}

resource "google_compute_global_forwarding_rule" "http_redirect" {
  project               = var.project_id
  name                  = "sgsai-http-forwarding-rule"
  load_balancing_scheme = "EXTERNAL_MANAGED"
  ip_protocol           = "TCP"
  port_range            = "80"
  target                = google_compute_target_http_proxy.redirect.id
  ip_address            = google_compute_global_address.website.id
}

resource "google_iam_workload_identity_pool" "github" {
  project                   = var.project_id
  workload_identity_pool_id = "github-actions"
  display_name              = "GitHub Actions deployments"
  description               = "OIDC identities from the SGS AI Technology home repository main branch."
  disabled                  = false

  depends_on = [google_project_service.required]
}

resource "google_iam_workload_identity_pool_provider" "github" {
  project                            = var.project_id
  workload_identity_pool_id          = google_iam_workload_identity_pool.github.workload_identity_pool_id
  workload_identity_pool_provider_id = "github"
  display_name                       = "GitHub Actions OIDC"
  description                        = "Restricted to ${var.repository_owner}/${var.repository_name}@refs/heads/${var.deploy_branch}."
  attribute_condition                = "assertion.repository == '${var.repository_owner}/${var.repository_name}' && assertion.repository_owner == '${var.repository_owner}' && assertion.ref == 'refs/heads/${var.deploy_branch}'"

  attribute_mapping = {
    "google.subject"             = "assertion.sub"
    "attribute.repository"       = "assertion.repository"
    "attribute.repository_owner" = "assertion.repository_owner"
    "attribute.ref"              = "assertion.ref"
  }

  oidc {
    issuer_uri = "https://token.actions.githubusercontent.com"
  }
}

resource "google_service_account" "github_deploy" {
  project      = var.project_id
  account_id   = "sgsai-github-deploy"
  display_name = "GitHub Actions website deployer"
  description  = "Federated deploy identity for the protected main branch of ${var.repository_owner}/${var.repository_name}."

  depends_on = [google_project_service.required]
}

resource "google_service_account_iam_member" "github_wif" {
  service_account_id = google_service_account.github_deploy.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.github.name}/attribute.repository/${var.repository_owner}/${var.repository_name}"
}

resource "google_project_iam_member" "github_run_admin" {
  project = var.project_id
  role    = "roles/run.admin"
  member  = "serviceAccount:${google_service_account.github_deploy.email}"
}

resource "google_project_iam_member" "github_service_usage" {
  project = var.project_id
  role    = "roles/serviceusage.serviceUsageConsumer"
  member  = "serviceAccount:${google_service_account.github_deploy.email}"
}

resource "google_artifact_registry_repository_iam_member" "github_writer" {
  project    = var.project_id
  location   = google_artifact_registry_repository.website.location
  repository = google_artifact_registry_repository.website.name
  role       = "roles/artifactregistry.writer"
  member     = "serviceAccount:${google_service_account.github_deploy.email}"
}

resource "google_service_account_iam_member" "github_act_as_runtime" {
  service_account_id = google_service_account.runtime.name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${google_service_account.github_deploy.email}"
}
