terraform {
  backend "pg" {}
  required_version = "~> 1.7"

  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "< 5.28.0"
    }
    gitlab = {
      source  = "gitlabhq/gitlab"
      version = "~> 19.4"
    }
    null = {
      source  = "hashicorp/null"
      version = ">= 3"
    }
    random = {
      source  = "hashicorp/random"
      version = ">= 3.6"
    }
  }
}
