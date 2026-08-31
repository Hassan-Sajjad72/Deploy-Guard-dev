mock_provider "aws" {
  mock_data "aws_iam_policy_document" {
    defaults = {
      json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}"
    }
  }
}
mock_provider "random" {}

run "managed_mongodb_with_apply_time_secret_arn_plans" {
  command = plan

  variables {
    region            = "us-east-1"
    project_id        = "11111111-1111-4111-8111-111111111111"
    operation_id      = "22222222-2222-4222-8222-222222222222"
    vpc_id            = "vpc-0123456789abcdef0"
    public_subnet_ids = ["subnet-0123456789abcdef0"]
    platform_port     = 8080
    services = {
      "33333333-3333-4333-8333-333333333333" = {
        name                       = "Backend"
        image                      = "123456789012.dkr.ecr.us-east-1.amazonaws.com/deployguard-test@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        runtime_config_revision_id = "44444444-4444-4444-8444-444444444444"
        environment                = { PORT = "8080", HOST = "0.0.0.0" }
        secret_references          = {}
        database_attached          = true
        managed_database_aliases   = ["MONGODB_URI", "MONGO_PASSWORD"]
        managed_database_engine    = "mongodb"
      }
    }
  }

  assert {
    condition     = length(aws_iam_role_policy.runtime_secrets) == 1
    error_message = "Managed MongoDB must plan one runtime-secret policy even though its generated secret ARN is unknown until apply."
  }

  assert {
    condition     = length(aws_secretsmanager_secret.database) == 1 && length(aws_ecs_service.database) == 1
    error_message = "Managed MongoDB must retain its independent Secrets Manager and ECS runtime."
  }
}
