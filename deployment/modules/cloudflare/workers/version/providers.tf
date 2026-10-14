provider "cloudflare" {
  api_token = local.api_token
}

# gitlab.futo.org, the one GitLab host projects.json may use (gitlab.tf checks),
# as the futo-version bot: a Maintainer of every GitLab project the service
# reads, which creates their release hooks and read tokens. PR stages create
# neither, and without early_auth_check they never call GitLab.
provider "gitlab" {
  base_url         = "https://gitlab.futo.org/api/v4/"
  token            = var.gitlab_tofu_token
  early_auth_check = false
}
