variable "project_id" {
  description = "Google Cloud project hosting the website."
  type        = string
  default     = "home-509818"
}

variable "region" {
  description = "Regional location for Cloud Run and Artifact Registry."
  type        = string
  default     = "asia-south1"
}

variable "repository_owner" {
  description = "GitHub organization/user allowed to deploy through Workload Identity Federation."
  type        = string
  default     = "sgsai-lab"
}

variable "repository_name" {
  description = "GitHub repository allowed to deploy through Workload Identity Federation."
  type        = string
  default     = "home"
}

variable "deploy_branch" {
  description = "Only this branch is trusted by the GitHub OIDC provider."
  type        = string
  default     = "main"
}

variable "apex_domain" {
  description = "Apex hostname served by the HTTPS load balancer."
  type        = string
  default     = "sgsaitechnology.com"
}

variable "www_domain" {
  description = "WWW hostname included on the HTTPS certificate."
  type        = string
  default     = "www.sgsaitechnology.com"
}

