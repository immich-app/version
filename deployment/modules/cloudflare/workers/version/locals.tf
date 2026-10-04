locals {
  resource_stage  = var.stage != "" ? "-${var.stage}" : ""
  resource_env    = "-${var.env}"
  resource_suffix = "${local.resource_env}${local.resource_stage}"

  # o11y has staging and prod stores only, so dev and PR stages ship to staging
  o11y_gateway = var.env == "prod" ? "https://vmauth.futostatus.com" : "https://vmauth.staging.futostatus.com"
}
