locals {
  enable_foundation         = var.enable_ecs_foundation || var.enable_ecs_service || var.enable_ecs_foundation_service
  enable_service            = var.enable_ecs_service || var.enable_ecs_foundation_service
  effective_image           = var.enable_ecs_service ? var.container_image : var.baseline_container_image
  short_project_id          = substr(replace(var.project_id, "-", ""), 0, 20)
  cluster_name              = "deployguard-${var.project_id}-${var.environment_name}"
  service_name              = "dg-${local.short_project_id}-${var.environment_name}-svc"
  log_group_name            = "/deployguard/${var.project_id}/${var.environment_name}/app"
  deployment_log_group_name = "/deployguard/${var.project_id}/${var.environment_name}/deployment"
  env_list = [
    for key, value in var.environment_variables : {
      name  = key
      value = value
    }
  ]
  secret_keys = nonsensitive(toset(keys(var.secret_environment_variables)))
  secret_list = [
    for key in local.secret_keys : {
      name      = key
      valueFrom = aws_secretsmanager_secret.environment[key].arn
    }
  ]
  external_secret_list = [
    for key, arn in var.external_secret_environment_variables : {
      name      = key
      valueFrom = arn
    }
  ]
  capacity_provider_strategy = var.use_fargate_spot ? concat(
    [{ capacity_provider = "FARGATE_SPOT", weight = 1, base = 0 }],
    var.enable_fargate_fallback ? [{ capacity_provider = "FARGATE", weight = 0, base = 1 }] : []
  ) : [{ capacity_provider = "FARGATE", weight = 1, base = 1 }]
  mount_points = var.efs_enabled ? [
    {
      sourceVolume  = "persistent-storage"
      containerPath = var.efs_container_path
      readOnly      = false
    }
  ] : []
}

resource "aws_secretsmanager_secret" "environment" {
  for_each = local.enable_service ? local.secret_keys : toset([])

  name                    = "deployguard/${var.project_id}/${var.environment_name}/${each.key}"
  recovery_window_in_days = 7
  tags = merge(var.tags, {
    ManagedBy            = "DeployGuard"
    DeployGuardProjectId = var.project_id
    Environment          = var.environment_name
    SecretPurpose        = "application_${each.key}"
    DeployGuardLifecycle = "retained"
  })
}

resource "aws_secretsmanager_secret_version" "environment" {
  for_each = aws_secretsmanager_secret.environment

  secret_id     = each.value.id
  secret_string = var.secret_environment_variables[each.key]

  lifecycle {
    ignore_changes = [secret_string]
  }
}

resource "aws_ecs_cluster" "this" {
  count = local.enable_foundation ? 1 : 0

  name = local.cluster_name

  setting {
    name  = "containerInsights"
    value = var.enable_container_insights ? "enabled" : "disabled"
  }

  tags = merge(var.tags, {
    Name                 = local.cluster_name
    ManagedBy            = "DeployGuard"
    DeployGuardProjectId = var.project_id
    Environment          = var.environment_name
  })
}

resource "aws_cloudwatch_log_group" "app" {
  count = local.enable_foundation ? 1 : 0

  name              = local.log_group_name
  retention_in_days = 14

  tags = merge(var.tags, {
    ManagedBy            = "DeployGuard"
    DeployGuardProjectId = var.project_id
    Environment          = var.environment_name
    LogPurpose           = "app"
  })
}

resource "aws_cloudwatch_log_group" "deployment" {
  count = local.enable_foundation ? 1 : 0

  name              = local.deployment_log_group_name
  retention_in_days = 14

  tags = merge(var.tags, {
    ManagedBy            = "DeployGuard"
    DeployGuardProjectId = var.project_id
    Environment          = var.environment_name
    LogPurpose           = "deployment"
  })
}

data "aws_iam_policy_document" "ecs_tasks_assume_role" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "execution" {
  count = local.enable_foundation ? 1 : 0

  name               = "dg-${local.short_project_id}-${var.environment_name}-exec"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume_role.json
  tags               = var.tags
}

resource "aws_iam_role_policy_attachment" "execution" {
  count = local.enable_foundation ? 1 : 0

  role       = aws_iam_role.execution[0].name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_iam_role_policy" "environment_secrets" {
  count = local.enable_service && (length(local.secret_keys) > 0 || length(var.external_secret_environment_variables) > 0) ? 1 : 0

  name = "environment-secrets"
  role = aws_iam_role.execution[0].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["secretsmanager:GetSecretValue"]
      Resource = concat([for secret in aws_secretsmanager_secret.environment : secret.arn], values(var.external_secret_environment_variables))
    }]
  })
}

resource "aws_iam_role" "task" {
  count = local.enable_foundation ? 1 : 0

  name               = "dg-${local.short_project_id}-${var.environment_name}-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume_role.json
  tags               = var.tags
}

resource "aws_iam_role_policy" "efs" {
  count = local.enable_service && var.efs_enabled ? 1 : 0

  name = "efs-client"
  role = aws_iam_role.task[0].id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "elasticfilesystem:ClientMount",
          "elasticfilesystem:ClientWrite"
        ]
        Resource = "*"
      }
    ]
  })
}

resource "aws_ecs_task_definition" "app" {
  count = local.enable_service ? 1 : 0

  family                   = "dg-${local.short_project_id}-${var.environment_name}"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = tostring(var.task_cpu)
  memory                   = tostring(var.task_memory)
  execution_role_arn       = aws_iam_role.execution[0].arn
  task_role_arn            = aws_iam_role.task[0].arn

  container_definitions = jsonencode([
    {
      name        = var.container_name
      image       = local.effective_image
      essential   = true
      environment = local.env_list
      secrets     = concat(local.secret_list, local.external_secret_list)
      mountPoints = local.mount_points
      portMappings = [
        {
          containerPort = var.container_port
          hostPort      = var.container_port
          protocol      = "tcp"
        }
      ]
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          awslogs-group         = aws_cloudwatch_log_group.app[0].name
          awslogs-region        = var.aws_region
          awslogs-stream-prefix = "ecs"
        }
      }
    }
  ])

  dynamic "volume" {
    for_each = var.efs_enabled ? [1] : []
    content {
      name = "persistent-storage"

      efs_volume_configuration {
        file_system_id     = var.efs_file_system_id
        transit_encryption = "ENABLED"

        authorization_config {
          access_point_id = var.efs_access_point_id
          iam             = "ENABLED"
        }
      }
    }
  }

  tags = var.tags
}

resource "aws_ecs_service" "app" {
  count = local.enable_service ? 1 : 0

  name                               = local.service_name
  cluster                            = aws_ecs_cluster.this[0].id
  task_definition                    = aws_ecs_task_definition.app[0].arn
  desired_count                      = var.desired_count
  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200
  health_check_grace_period_seconds  = var.health_check_grace_seconds
  enable_execute_command             = false

  dynamic "capacity_provider_strategy" {
    for_each = local.capacity_provider_strategy
    content {
      capacity_provider = capacity_provider_strategy.value.capacity_provider
      weight            = capacity_provider_strategy.value.weight
      base              = capacity_provider_strategy.value.base
    }
  }

  network_configuration {
    subnets          = var.subnet_ids
    security_groups  = [var.app_security_group_id]
    assign_public_ip = var.assign_public_ip
  }

  load_balancer {
    target_group_arn = var.target_group_arn
    container_name   = var.container_name
    container_port   = var.container_port
  }

  dynamic "service_registries" {
    for_each = var.service_discovery_service_arn == null ? [] : [var.service_discovery_service_arn]
    content {
      registry_arn = service_registries.value
    }
  }

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  tags = merge(var.tags, {
    ManagedBy            = "DeployGuard"
    DeployGuardProjectId = var.project_id
    Environment          = var.environment_name
  })

  depends_on = [aws_iam_role_policy_attachment.execution]
}

resource "aws_appautoscaling_target" "ecs" {
  count = local.enable_service && var.enable_autoscaling ? 1 : 0

  max_capacity       = var.max_tasks
  min_capacity       = var.min_tasks
  resource_id        = "service/${aws_ecs_cluster.this[0].name}/${aws_ecs_service.app[0].name}"
  scalable_dimension = "ecs:service:DesiredCount"
  service_namespace  = "ecs"
}

resource "aws_appautoscaling_policy" "cpu" {
  count = local.enable_service && var.enable_autoscaling ? 1 : 0

  name               = "${local.service_name}-cpu"
  policy_type        = "TargetTrackingScaling"
  resource_id        = aws_appautoscaling_target.ecs[0].resource_id
  scalable_dimension = aws_appautoscaling_target.ecs[0].scalable_dimension
  service_namespace  = aws_appautoscaling_target.ecs[0].service_namespace

  target_tracking_scaling_policy_configuration {
    predefined_metric_specification {
      predefined_metric_type = "ECSServiceAverageCPUUtilization"
    }

    target_value = var.cpu_target_percent
  }
}
