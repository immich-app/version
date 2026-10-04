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
  description = "Bearer token for the o11y vmauth gateway. Metrics are only shipped when this is set"
  type        = string
  sensitive   = true
  default     = ""
}

variable "github_app_readonly_id" {
  description = "GitHub App ID for the Immich Read-Only app"
  type        = string
}

variable "github_app_readonly_pem_file" {
  description = "GitHub App private key (PEM) for the Immich Read-Only app"
  type        = string
  sensitive   = true
}

variable "github_app_readonly_installation_id" {
  description = "GitHub App installation ID for the Immich Read-Only app"
  type        = string
}
