locals {
  # projects.json's GitLab projects, keyed host/projectId as the worker's
  # GITLAB_TOKENS is, once each however many registry entries read them. Only
  # dev main and prod hook them: a PR stage's hook would deliver to a URL that
  # is gone once the stage is torn down.
  gitlab_projects = {
    for key, sources in {
      for project in jsondecode(file(var.projects_file)).projects :
      "${project.source.host}/${project.source.projectId}" => project.source...
      if var.stage == "" && project.source.type == "gitlab-releases"
    } : key => sources[0]
  }

  # GitLab's signing tokens are whsec_ and a base64 32-byte key (Standard
  # Webhooks), which the worker checks deliveries against.
  gitlab_signing_token = var.stage == "" ? "whsec_${random_bytes.gitlab_webhook[0].base64}" : ""
}

# One key for this env's hooks, kept in its state; the worker gets it as
# GITLAB_WEBHOOK_SECRET.
resource "random_bytes" "gitlab_webhook" {
  count  = var.stage == "" ? 1 : 0
  length = 32
}

# Each GitLab project's release events, posted to this env's /webhook/gitlab.
# The worker answers them by asking GitLab for the release, so a delivery that
# fails is caught up by the next */30 sync: GitLab never retries one.
resource "gitlab_project_hook" "release" {
  for_each = local.gitlab_projects

  project                 = each.value.projectId
  name                    = "version service (${var.env})"
  description             = "Releases for ${module.domain.fqdn}, managed by immich-app/version"
  url                     = "https://${module.domain.fqdn}/webhook/gitlab"
  signing_token           = local.gitlab_signing_token
  releases_events         = true
  push_events             = false
  enable_ssl_verification = true

  lifecycle {
    precondition {
      condition     = each.value.host == "gitlab.futo.org"
      error_message = "The gitlab provider only reaches gitlab.futo.org, so ${each.key} can't get a hook or a read token."
    }
    precondition {
      condition     = nonsensitive(!contains(["", "REPLACE_ME"], var.gitlab_tofu_token))
      error_message = "TF_VAR_gitlab_tofu_token must hold the futo-version GitLab bot's token (op://tf/FUTO_VERSION_GITLAB_TOFU_TOKEN), not a placeholder."
    }
  }
}

# Each GitLab project's read token: Reporter, since the by-tag release endpoint
# the webhook and the retraction checks use needs read_code, which Guest lacks.
# It rotates on the first apply in the 60 days before it expires; main deploys
# dev and prod on every push.
resource "gitlab_project_access_token" "read" {
  for_each = local.gitlab_projects

  project      = each.value.projectId
  name         = "version service (${var.env})"
  description  = "Reads releases for ${module.domain.fqdn}, managed by immich-app/version"
  access_level = "reporter"
  scopes       = ["read_api"]

  rotation_configuration = {
    expiration_days    = 365
    rotate_before_days = 60
  }
}
