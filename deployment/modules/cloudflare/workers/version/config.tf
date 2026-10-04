terraform {
  backend "pg" {}
  required_version = "~> 1.7"

  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "< 5.26.0"
    }
    null = {
      source  = "hashicorp/null"
      version = ">= 3"
    }
    random = {
      source  = "hashicorp/random"
      version = ">= 3"
    }
  }
}
