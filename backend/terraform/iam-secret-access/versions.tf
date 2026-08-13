terraform {
  required_version = ">= 1.10.0"

  backend "s3" {}

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region                      = var.aws_region
  allowed_account_ids         = [var.aws_account_id]
  access_key                  = var.offline_plan_mode ? "offline-plan" : null
  secret_key                  = var.offline_plan_mode ? "offline-plan" : null
  skip_credentials_validation = var.offline_plan_mode
  skip_metadata_api_check     = var.offline_plan_mode
  skip_region_validation      = var.offline_plan_mode
  skip_requesting_account_id  = var.offline_plan_mode
}
