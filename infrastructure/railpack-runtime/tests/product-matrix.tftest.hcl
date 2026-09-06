mock_provider "aws" {
  mock_data "aws_iam_policy_document" {
    defaults = { json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}" }
  }
}
mock_provider "random" {}

variables {
  region            = "us-east-1"
  project_id        = "11111111-1111-4111-8111-111111111111"
  operation_id      = "22222222-2222-4222-8222-222222222222"
  environment_name  = "dev"
  vpc_id            = "vpc-0123456789abcdef0"
  public_subnet_ids = ["subnet-0123456789abcdef0", "subnet-0123456789abcdef1"]
}

run "one_service_without_database_or_secrets" {
  command = plan
  variables {
    services = {
      "33333333-3333-4333-8333-333333333333" = {
        name                       = "Web", image = "registry/web@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        runtime_config_revision_id = "44444444-4444-4444-8444-444444444444"
        service_port               = 8080
        environment                = { PORT = "8080", HOST = "0.0.0.0" }, secret_references = {}
        database_attached          = false, managed_database_aliases = [], managed_database_engine = "postgres"
      }
    }
  }
  assert {
    condition     = aws_ecs_cluster.project.name == "dg-111111111111"
    error_message = "A project must own exactly one ECS cluster."
  }
  assert {
    condition     = length(aws_ecs_service.application) == 1 && length(aws_ecs_task_definition.application) == 1 && length(aws_lb.application) == 1 && length(aws_lb_target_group.application) == 1 && length(aws_cloudwatch_log_group.application) == 1
    error_message = "One service must materialize one independent application runtime identity."
  }
  assert {
    condition     = length(aws_ecs_service.database) == 0 && length(aws_efs_file_system.database) == 0 && length(aws_service_discovery_private_dns_namespace.database) == 0
    error_message = "No managed database may materialize database, EFS, or Cloud Map resources."
  }
  assert {
    condition     = length(aws_iam_role_policy.runtime_secrets) == 0
    error_message = "No runtime-secret IAM policy is allowed when no secret exists."
  }
  assert {
    condition     = aws_ecs_service.application["33333333-3333-4333-8333-333333333333"].desired_count == 1
    error_message = "A service without a managed database must start independently at its intended desired count."
  }
  assert {
    condition     = length(output.services) == 1 && output.database_efs_file_system_id == null && output.database_efs_access_point_id == null
    error_message = "Release evidence outputs must represent the exact service set and absent database."
  }
  assert {
    condition = (
      output.services["33333333-3333-4333-8333-333333333333"].transport_probe_container_name == "deployguard-transport-probe" &&
      output.services["33333333-3333-4333-8333-333333333333"].transport_probe_port == 65535 &&
      output.services["33333333-3333-4333-8333-333333333333"].platform_health_check_path == "/_deployguard/transport-ready" &&
      aws_lb_target_group.application["33333333-3333-4333-8333-333333333333"].health_check[0].port == "65535" &&
      aws_lb_target_group.application["33333333-3333-4333-8333-333333333333"].health_check[0].path == "/_deployguard/transport-ready" &&
      jsondecode(aws_ecs_task_definition.application["33333333-3333-4333-8333-333333333333"].container_definitions)[1].name == "deployguard-transport-probe"
    )
    error_message = "Default ALB readiness must use the platform-owned TCP transport probe, not the developer application route."
  }
}

run "two_services_with_generic_runtime_secret" {
  command = plan
  variables {
    services = {
      "33333333-3333-4333-8333-333333333333" = {
        name                       = "Web", image = "registry/web@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        runtime_config_revision_id = "44444444-4444-4444-8444-444444444444"
        service_port               = 3000
        environment                = { PORT = "3000", HOST = "0.0.0.0" }
        secret_references          = { API_KEY = "arn:aws:secretsmanager:us-east-1:123456789012:secret:deployguard/api:API_KEY::aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }
        database_attached          = false, managed_database_aliases = [], managed_database_engine = "postgres"
      }
      "55555555-5555-4555-8555-555555555555" = {
        name                       = "Worker", image = "registry/worker@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
        runtime_config_revision_id = "66666666-6666-4666-8666-666666666666"
        service_port               = 8000
        environment                = { PORT = "8000", HOST = "0.0.0.0" }, secret_references = {}
        database_attached          = false, managed_database_aliases = [], managed_database_engine = "postgres"
      }
    }
  }
  assert {
    condition     = length(aws_ecs_service.application) == 2 && length(output.services) == 2
    error_message = "Two configured services must materialize two independent runtimes and evidence records."
  }
  assert {
    condition     = length(aws_iam_role_policy.runtime_secrets) == 1 && length(aws_ecs_service.database) == 0
    error_message = "A generic runtime secret requires one plan-known IAM policy and no database runtime."
  }
  assert {
    condition     = output.services["33333333-3333-4333-8333-333333333333"].image != output.services["55555555-5555-4555-8555-555555555555"].image
    error_message = "Immutable images must remain service-scoped."
  }
  assert {
    condition = (
      output.services["33333333-3333-4333-8333-333333333333"].service_port == 3000 &&
      output.services["55555555-5555-4555-8555-555555555555"].service_port == 8000 &&
      aws_lb_target_group.application["33333333-3333-4333-8333-333333333333"].port == 3000 &&
      aws_lb_target_group.application["55555555-5555-4555-8555-555555555555"].port == 8000 &&
      aws_lb_target_group.application["33333333-3333-4333-8333-333333333333"].name == "dg-111111111111-33333333-3000" &&
      aws_lb_target_group.application["55555555-5555-4555-8555-555555555555"].name == "dg-111111111111-55555555-8000" &&
      jsondecode(aws_ecs_task_definition.application["33333333-3333-4333-8333-333333333333"].container_definitions)[0].portMappings[0].containerPort == 3000 &&
      jsondecode(aws_ecs_task_definition.application["55555555-5555-4555-8555-555555555555"].container_definitions)[0].portMappings[0].containerPort == 8000 &&
      jsondecode(aws_ecs_task_definition.application["33333333-3333-4333-8333-333333333333"].container_definitions)[1].environment[0].value == "3000" &&
      jsondecode(aws_ecs_task_definition.application["55555555-5555-4555-8555-555555555555"].container_definitions)[1].environment[0].value == "8000"
    )
    error_message = "Each service port must remain independent through release output, target group, ECS task definition, and platform transport probe."
  }
}

run "postgres_database_attached_to_service_a" {
  command = plan
  variables {
    services = {
      "33333333-3333-4333-8333-333333333333" = {
        name                       = "Api", image = "registry/api@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        runtime_config_revision_id = "44444444-4444-4444-8444-444444444444"
        service_port               = 8080
        environment                = { PORT = "8080", HOST = "0.0.0.0" }, secret_references = {}
        database_attached          = true, managed_database_aliases = ["DATABASE_URL", "DB_HOST", "DB_PORT"], managed_database_engine = "postgres"
      }
      "55555555-5555-4555-8555-555555555555" = {
        name                       = "Web", image = "registry/web@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
        runtime_config_revision_id = "66666666-6666-4666-8666-666666666666"
        service_port               = 8080
        environment                = { PORT = "8080", HOST = "0.0.0.0" }, secret_references = {}
        database_attached          = false, managed_database_aliases = [], managed_database_engine = "postgres"
      }
    }
  }
  assert {
    condition     = aws_ecs_service.database[0].deployment_minimum_healthy_percent == 0 && aws_ecs_service.database[0].deployment_maximum_percent == 100
    error_message = "A singleton managed database must stop its prior task before replacement to prevent concurrent access to persistent storage."
  }
  assert {
    condition     = length(aws_ecs_service.database) == 1 && length(aws_efs_file_system.database) == 1 && length(aws_efs_access_point.database) == 1 && length(aws_service_discovery_private_dns_namespace.database) == 1
    error_message = "Managed PostgreSQL must be an independent persistent runtime with Cloud Map identity."
  }
  assert {
    condition     = length(aws_efs_mount_target.database) == 2 && length(aws_iam_role_policy.runtime_secrets) == 1
    error_message = "Managed database persistence and secret IAM cardinality must be plan-known."
  }
  assert {
    condition     = nonsensitive(output.database).attached_service_id == "33333333-3333-4333-8333-333333333333" && nonsensitive(output.database).engine == "postgres" && nonsensitive(output.database).port == 5432
    error_message = "Database evidence must preserve attachment ownership and PostgreSQL identity."
  }
  assert {
    condition = (
      aws_ecs_service.application["33333333-3333-4333-8333-333333333333"].desired_count == 0 &&
      aws_ecs_service.application["55555555-5555-4555-8555-555555555555"].desired_count == 1
    )
    error_message = "Only the PostgreSQL-attached application may wait at zero while unrelated services start independently."
  }
}

run "mysql_database_attached_to_service_b" {
  command = plan
  variables {
    services = {
      "33333333-3333-4333-8333-333333333333" = {
        name                       = "Web", image = "registry/web@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        runtime_config_revision_id = "44444444-4444-4444-8444-444444444444"
        service_port               = 8080
        environment                = { PORT = "8080", HOST = "0.0.0.0" }, secret_references = {}
        database_attached          = false, managed_database_aliases = [], managed_database_engine = "postgres"
      }
      "55555555-5555-4555-8555-555555555555" = {
        name                       = "Api", image = "registry/api@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
        runtime_config_revision_id = "66666666-6666-4666-8666-666666666666"
        service_port               = 8080
        environment                = { PORT = "8080", HOST = "0.0.0.0" }, secret_references = {}
        database_attached          = true, managed_database_aliases = ["DB_HOST", "DATABASE_HOST", "MYSQL_HOST", "DB_PORT", "DATABASE_PORT", "MYSQL_PORT", "DB_USER", "DATABASE_USER", "MYSQL_USER", "DB_PASSWORD", "DATABASE_PASSWORD", "MYSQL_PASSWORD", "DB_NAME", "DATABASE_NAME", "MYSQL_DATABASE", "DATABASE_URL", "MYSQL_URL"], managed_database_engine = "mysql"
      }
    }
  }
  assert {
    condition     = nonsensitive(output.database).attached_service_id == "55555555-5555-4555-8555-555555555555" && nonsensitive(output.database).engine == "mysql" && nonsensitive(output.database).port == 3306
    error_message = "Service ordering must not change MySQL attachment authority."
  }
  assert {
    condition     = length(aws_ecs_task_definition.application) == 2 && length(aws_ecs_task_definition.database) == 1
    error_message = "The database must remain independent from both application task definitions."
  }
  assert {
    condition = (
      strcontains(join("\n", local.mysql_database_command), "[ ! -d /var/lib/mysql/mysql ]") &&
      strcontains(join("\n", local.mysql_database_command), "ALTER USER 'root'@'localhost'") &&
      strcontains(join("\n", local.mysql_database_command), "CREATE DATABASE IF NOT EXISTS application;") &&
      strcontains(join("\n", local.mysql_database_command), "GRANT ALL PRIVILEGES ON application.* TO 'deployguard'@'%';") &&
      !strcontains(join("\n", local.mysql_database_command), "`") &&
      !strcontains(join("\n", local.mysql_grant_reconciler_command), "`") &&
      strcontains(join("\n", local.mysql_database_command), "--init-file=\"$bootstrap\"")
    )
    error_message = "Managed MySQL must recover persisted administrative credentials without replacing fresh-volume initialization."
  }
  assert {
    condition = (
      aws_ecs_service.application["33333333-3333-4333-8333-333333333333"].desired_count == 1 &&
      aws_ecs_service.application["55555555-5555-4555-8555-555555555555"].desired_count == 0
    )
    error_message = "Only the MySQL-attached application may wait at zero independent of service ordering."
  }
  assert {
    condition = (
      alltrue([for alias in ["DB_HOST", "DATABASE_HOST", "MYSQL_HOST", "DB_PORT", "DATABASE_PORT", "MYSQL_PORT", "DB_USER", "DATABASE_USER", "MYSQL_USER", "DB_NAME", "DATABASE_NAME", "MYSQL_DATABASE"] : contains(keys(local.database_environment), alias)]) &&
      alltrue([for alias in ["DB_PASSWORD", "DATABASE_PASSWORD", "MYSQL_PASSWORD", "DATABASE_URL", "MYSQL_URL"] : contains(keys(local.database_secrets), alias)])
    )
    error_message = "Every DeployGuard-owned MySQL alias must be prepared for injection into the attached application task definition."
  }
}

run "incomplete_mysql_aliases_are_rejected" {
  command = plan
  variables {
    services = {
      "55555555-5555-4555-8555-555555555555" = {
        name                       = "Api", image = "registry/api@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
        runtime_config_revision_id = "66666666-6666-4666-8666-666666666666"
        service_port               = 8080
        environment                = { PORT = "8080", HOST = "0.0.0.0" }, secret_references = {}
        database_attached          = true, managed_database_aliases = ["MYSQL_HOST", "MYSQL_PORT", "MYSQL_USER", "MYSQL_PASSWORD", "MYSQL_URL"], managed_database_engine = "mysql"
      }
    }
  }
  expect_failures = [var.services]
}

run "rollback_immutable_images_and_config" {
  command = plan
  variables {
    services = {
      "55555555-5555-4555-8555-555555555555" = {
        name                       = "Worker", image = "registry/worker@sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
        runtime_config_revision_id = "66666666-6666-4666-8666-666666666666"
        service_port               = 8080
        environment                = { PORT = "8080", HOST = "0.0.0.0", RELEASE = "historical" }, secret_references = {}
        database_attached          = false, managed_database_aliases = [], managed_database_engine = "postgres"
      }
      "33333333-3333-4333-8333-333333333333" = {
        name                       = "Web", image = "registry/web@sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
        runtime_config_revision_id = "44444444-4444-4444-8444-444444444444"
        service_port               = 8080
        environment                = { PORT = "8080", HOST = "0.0.0.0", RELEASE = "historical" }, secret_references = {}
        database_attached          = false, managed_database_aliases = [], managed_database_engine = "postgres"
      }
    }
  }
  assert {
    condition     = output.services["33333333-3333-4333-8333-333333333333"].runtime_config_revision_id == "44444444-4444-4444-8444-444444444444" && output.services["55555555-5555-4555-8555-555555555555"].runtime_config_revision_id == "66666666-6666-4666-8666-666666666666"
    error_message = "Rollback must preserve the complete immutable service/config revision set independent of map order."
  }
  assert {
    condition     = output.services["33333333-3333-4333-8333-333333333333"].image == "registry/web@sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
    error_message = "Rollback output must preserve the exact historical immutable image."
  }
}
