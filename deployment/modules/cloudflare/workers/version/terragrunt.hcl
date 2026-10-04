terraform {
  source = "."

  extra_arguments custom_vars {
    commands = get_terraform_commands_that_need_vars()
  }
}

include {
  path = find_in_parent_folders("state.hcl")
}

locals {
  env      = get_env("TF_VAR_env")
  stage    = get_env("TF_VAR_stage")
  app_name = "version"
  # The zone also names the state schema, so it must not change after the first apply.
  zone_name = "futo.cloud"
}

inputs = {
  app_name  = local.app_name
  zone_name = local.zone_name
}

remote_state {
  backend = "pg"

  config = {
    conn_str    = get_env("TF_VAR_tf_state_postgres_conn_str")
    schema_name = "cloudflare_workers_${replace(local.zone_name, ".", "_")}_${local.app_name}_${local.env}${local.stage}"
  }
}
