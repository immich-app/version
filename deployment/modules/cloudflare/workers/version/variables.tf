variable "stage" {}
variable "env" {}
variable "app_name" {}
variable "dist_dir" {}

variable "zone_name" {
  description = "Zone the worker is served under, set in terragrunt.hcl"
  type        = string
}

variable "migrations_dir" {
  description = "Absolute path to D1 migration SQL files"
  type        = string
}

variable "o11y_vmauth_token" {
  description = "Bearer token for the o11y vmauth gateway. Required for dev main and prod, which always ship metrics; unused by PR stages, which never do"
  type        = string
  sensitive   = true
  default     = ""
}

variable "github_app_version_id" {
  description = "GitHub App ID for the version service's own app, which reads releases through its installation on each repository's owner"
  type        = string
}

variable "github_app_version_pem_file" {
  description = "GitHub App private key (PKCS#8 PEM) for the version service's own app"
  type        = string
  sensitive   = true
}

variable "github_app_version_webhook_secret" {
  description = "Secret the version service's GitHub App signs its release webhook with. Bound on dev main and prod; PR stages get no deliveries"
  type        = string
  sensitive   = true
  default     = ""
}

variable "projects_file" {
  description = "Absolute path to projects.json, whose GitLab projects get a release hook and a read token on dev main and prod"
  type        = string
}

variable "gitlab_tofu_token" {
  description = "API token of the futo-version GitLab bot, a Maintainer of every GitLab project in projects.json, which creates their release hooks and read tokens. Required for dev main and prod; PR stages create neither"
  type        = string
  sensitive   = true
  default     = ""
}
