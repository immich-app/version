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

variable "github_app_tofu_id" {
  description = "GitHub App ID for the Immich Tofu app, which manages the release webhook"
  type        = string
}

variable "github_app_tofu_installation_id" {
  description = "GitHub App installation ID for the Immich Tofu app"
  type        = string
}

variable "github_app_tofu_pem_file" {
  description = "GitHub App private key (PEM) for the Immich Tofu app"
  type        = string
  sensitive   = true
}

variable "github_app_tofu_owner" {
  description = "GitHub organisation the Immich Tofu app acts on"
  type        = string
}
