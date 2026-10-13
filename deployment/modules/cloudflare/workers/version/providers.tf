provider "cloudflare" {
  api_token = local.api_token
}

# Only kept so the apply that removes the old release hooks on immich-app/immich
# (webhook.tf, now replaced by the GitHub App's webhook) can delete them. Drop
# it, its github_app_tofu_* variables and their .env lines once dev and prod
# have applied that.
provider "github" {
  app_auth {
    id              = var.github_app_tofu_id
    installation_id = var.github_app_tofu_installation_id
    pem_file        = var.github_app_tofu_pem_file
  }
  owner = var.github_app_tofu_owner
}
