# Only prod and dev get a hook on the immich repo; PR stages rely on the sync crons.
resource "github_repository_webhook" "release" {
  count      = var.stage == "" ? 1 : 0
  repository = "immich"
  events     = ["release"]

  configuration {
    url          = "https://${module.domain.fqdn}/webhook"
    content_type = "json"
    secret       = random_password.webhook_secret.result
  }
}
