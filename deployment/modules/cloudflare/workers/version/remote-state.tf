variable "tf_state_postgres_conn_str" {
  description = "PostgreSQL connection string for Terraform state"
  type        = string
}

data "terraform_remote_state" "futo_api_keys" {
  backend = "pg"

  config = {
    conn_str    = var.tf_state_postgres_conn_str
    schema_name = "prod_cloudflare_futo_api_keys"
  }
}

locals {
  account_id = data.terraform_remote_state.futo_api_keys.outputs.cloudflare_account_id
  api_token  = data.terraform_remote_state.futo_api_keys.outputs.version_deploy_token
}
