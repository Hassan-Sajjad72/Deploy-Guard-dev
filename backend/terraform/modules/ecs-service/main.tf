locals {
  short_project_id = substr(replace(var.project_id, "-", ""), 0, 20)
  cluster_name     = "deployguard-${var.project_id}-${var.environment_name}"
  service_name     = "dg-${local.short_project_id}-${var.environment_name}-svc"
  log_group_name   = "/deployguard/${var.project_id}/${var.environment_name}/app"
  env_list = [
    for key, value in var.environment_variables : {
      name  = key
      value = value
    }
  ]
  capacity_provider_strategy = var.use_fargate_spot ? concat(
    [{ capacity_provider = "FARGATE_SPOT", weight = 1 }],
    var.enable_fargate_fallback ? [{ capacity_provider = "FARGATE", weight = 0 }] : []
  ) : [{ capacity_provider = "FARGATE", weight = 1 }]
  mount_points = var.efs_enabled ? [
    {
      sourceVolume  = "persistent-storage"
      containerPath = var.efs_container_path
      readOnly      = false
    }
  ] : []
}

resource "aws_ecs_cluster" "this" {
  count = var.enable_ecs_service ? 1 : 0

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
  count = var.enable_ecs_service ? 1 : 0

  name              = local.log_group_name
  retention_in_days = 14

  tags = var.tags
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
  count = var.enable_ecs_service ? 1 : 0

  name               = "dg-${local.short_project_id}-${var.environment_name}-exec"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume_role.json
  tags               = var.tags
}

resource "aws_iam_role_policy_attachment" "execution" {
  count = var.enable_ecs_service ? 1 : 0

  role       = aws_iam_role.execution[0].name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_iam_role" "task" {
  count = var.enable_ecs_service ? 1 : 0

  name               = "dg-${local.short_project_id}-${var.environment_name}-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume_role.json
  tags               = var.tags
}

resource "aws_iam_role_policy" "efs" {
  count = var.enable_ecs_service && var.efs_enabled ? 1 : 0

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
  count = var.enable_ecs_service ? 1 : 0

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
      image       = var.container_image
      essential   = true
      environment = local.env_list
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

resource "aws_service_discovery_service" "app" {
  count = var.enable_ecs_service && var.cloud_map_namespace_id != null ? 1 : 0

  name = "app"

  dns_config {
    namespace_id = var.cloud_map_namespace_id

    dns_records {
      ttl  = 10
      type = "A"
    }
  }

  health_check_custom_config {
    failure_threshold = 1
  }
}

resource "aws_ecs_service" "app" {
  count = var.enable_ecs_service ? 1 : 0

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
    }
  }

  network_configuration {
    subnets          = var.private_subnet_ids
    security_groups  = [var.app_security_group_id]
    assign_public_ip = false
  }

  load_balancer {
    target_group_arn = var.target_group_arn
    container_name   = var.container_name
    container_port   = var.container_port
  }

  dynamic "service_registries" {
    for_each = length(aws_service_discovery_service.app) > 0 ? [1] : []
    content {
      registry_arn = aws_service_discovery_service.app[0].arn
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
  count = var.enable_ecs_service ? 1 : 0

  max_capacity       = var.max_tasks
  min_capacity       = var.min_tasks
  resource_id        = "service/${aws_ecs_cluster.this[0].name}/${aws_ecs_service.app[0].name}"
  scalable_dimension = "ecs:service:DesiredCount"
  service_namespace  = "ecs"
}

resource "aws_appautoscaling_policy" "cpu" {
  count = var.enable_ecs_service ? 1 : 0

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
