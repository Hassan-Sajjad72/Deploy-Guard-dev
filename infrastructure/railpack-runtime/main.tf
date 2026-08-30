terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.0"
    }
  }
  backend "s3" {}
}
provider "aws" { region = var.region }

locals {
  project_name        = "dg-${substr(replace(var.project_id, "-", ""), 0, 12)}"
  database_services   = { for id, service in var.services : id => service if service.database_attached }
  database_enabled    = length(local.database_services) == 1
  database_service_id = local.database_enabled ? keys(local.database_services)[0] : null
  database_service    = local.database_enabled ? values(local.database_services)[0] : null
  database_engine     = local.database_enabled ? local.database_service.managed_database_engine : "postgres"
  database_aliases    = local.database_enabled ? local.database_service.managed_database_aliases : []
  database_port       = local.database_engine == "mysql" ? 3306 : local.database_engine == "mongodb" ? 27017 : 5432
  database_image      = local.database_engine == "mysql" ? "mysql:8" : local.database_engine == "mongodb" ? "mongo:8" : "postgres:16"
  database_path       = local.database_engine == "mysql" ? "/var/lib/mysql" : local.database_engine == "mongodb" ? "/data/db" : "/var/lib/postgresql/data"
  tags = {
    ManagedBy              = "DeployGuard"
    DeployGuardProjectId   = var.project_id
    DeployGuardOperationId = var.operation_id
  }
  runtime_secret_arns = distinct(concat(
    flatten([for service in values(var.services) : [for reference in values(service.secret_references) : join(":", slice(split(":", reference), 0, 7))]]),
    local.database_enabled ? [aws_secretsmanager_secret.database[0].arn] : [],
  ))
  database_environment = local.database_enabled ? {
    for key in local.database_aliases : key => contains(["DB_PORT", "DATABASE_PORT", "POSTGRES_PORT", "PGPORT", "MYSQL_PORT", "MONGO_PORT", "MONGODB_PORT"], key) ? tostring(local.database_port) : contains(["DB_HOST", "DATABASE_HOST", "POSTGRES_HOST", "PGHOST", "MYSQL_HOST", "MONGO_HOST", "MONGODB_HOST"], key) ? "127.0.0.1" : contains(["DB_USER", "DATABASE_USER", "POSTGRES_USER", "PGUSER", "MYSQL_USER", "MONGO_USER", "MONGODB_USER"], key) ? "deployguard" : "application"
    if !contains(["DB_PASSWORD", "DATABASE_PASSWORD", "POSTGRES_PASSWORD", "PGPASSWORD", "MYSQL_PASSWORD", "MONGO_PASSWORD", "MONGODB_PASSWORD", "DATABASE_URL", "POSTGRES_URL", "POSTGRESQL_URL", "MYSQL_URL", "MONGO_URI", "MONGO_URL", "MONGODB_URI"], key)
  } : {}
  database_secrets = local.database_enabled ? {
    for key in local.database_aliases : key => "${aws_secretsmanager_secret.database[0].arn}:${contains(["DATABASE_URL", "POSTGRES_URL", "POSTGRESQL_URL", "MYSQL_URL", "MONGO_URI", "MONGO_URL", "MONGODB_URI"], key) ? "url" : "password"}::"
    if contains(["DB_PASSWORD", "DATABASE_PASSWORD", "POSTGRES_PASSWORD", "PGPASSWORD", "MYSQL_PASSWORD", "MONGO_PASSWORD", "MONGODB_PASSWORD", "DATABASE_URL", "POSTGRES_URL", "POSTGRESQL_URL", "MYSQL_URL", "MONGO_URI", "MONGO_URL", "MONGODB_URI"], key)
  } : {}
}

resource "aws_ecs_cluster" "project" {
  name = local.project_name
  tags = local.tags
}
resource "aws_cloudwatch_log_group" "application" {
  for_each          = var.services
  name              = "/deployguard/${var.project_id}/services/${each.key}"
  retention_in_days = 14
  tags              = merge(local.tags, { DeployGuardServiceId = each.key })
}
resource "aws_security_group" "load_balancer" {
  for_each    = var.services
  name_prefix = "${local.project_name}-${substr(replace(each.key, "-", ""), 0, 8)}-alb-"
  vpc_id      = var.vpc_id
  ingress {
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
  tags = merge(local.tags, { DeployGuardServiceId = each.key })
}
resource "aws_security_group" "application" {
  for_each    = var.services
  name_prefix = "${local.project_name}-${substr(replace(each.key, "-", ""), 0, 8)}-app-"
  vpc_id      = var.vpc_id
  ingress {
    from_port       = var.platform_port
    to_port         = var.platform_port
    protocol        = "tcp"
    security_groups = [aws_security_group.load_balancer[each.key].id]
  }
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
  tags = merge(local.tags, { DeployGuardServiceId = each.key })
}

resource "aws_security_group" "database" {
  count       = local.database_enabled ? 1 : 0
  name_prefix = "${local.project_name}-database-"
  vpc_id      = var.vpc_id
  ingress {
    from_port       = 2049
    to_port         = 2049
    protocol        = "tcp"
    security_groups = local.database_enabled ? [aws_security_group.application[local.database_service_id].id] : []
  }
  tags = local.tags
}
resource "aws_efs_file_system" "database" {
  count           = local.database_enabled ? 1 : 0
  encrypted       = true
  throughput_mode = "bursting"
  tags            = local.tags
}
resource "aws_efs_access_point" "database" {
  count          = local.database_enabled ? 1 : 0
  file_system_id = aws_efs_file_system.database[0].id
  posix_user {
    gid = 999
    uid = 999
  }
  root_directory {
    path = "/database"
    creation_info {
      owner_gid   = 999
      owner_uid   = 999
      permissions = "0750"
    }
  }
  tags = local.tags
}
resource "aws_efs_mount_target" "database" {
  for_each        = local.database_enabled ? toset(var.public_subnet_ids) : toset([])
  file_system_id  = aws_efs_file_system.database[0].id
  subnet_id       = each.value
  security_groups = [aws_security_group.database[0].id]
}
resource "random_password" "database" {
  count   = local.database_enabled ? 1 : 0
  length  = 32
  special = false
}
resource "aws_secretsmanager_secret" "database" {
  count = local.database_enabled ? 1 : 0
  name  = "deployguard/${var.project_id}/database"
  tags  = local.tags
}
resource "aws_secretsmanager_secret_version" "database" {
  count     = local.database_enabled ? 1 : 0
  secret_id = aws_secretsmanager_secret.database[0].id
  secret_string = jsonencode({
    password = random_password.database[0].result
    url      = "${local.database_engine == "mysql" ? "mysql" : local.database_engine == "mongodb" ? "mongodb" : "postgresql"}://deployguard:${random_password.database[0].result}@127.0.0.1:${local.database_port}/application${local.database_engine == "mongodb" ? "?authSource=admin" : ""}"
  })
}

data "aws_iam_policy_document" "ecs_task_assume_role" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}
resource "aws_iam_role" "execution" {
  name               = "${local.project_name}-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_task_assume_role.json
  tags               = local.tags
}
resource "aws_iam_role_policy_attachment" "execution" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}
data "aws_iam_policy_document" "runtime_secrets" {
  count = length(local.runtime_secret_arns) > 0 ? 1 : 0
  statement {
    actions   = ["secretsmanager:GetSecretValue"]
    resources = local.runtime_secret_arns
  }
}
resource "aws_iam_role_policy" "runtime_secrets" {
  count  = length(local.runtime_secret_arns) > 0 ? 1 : 0
  name   = "runtime-secrets"
  role   = aws_iam_role.execution.id
  policy = data.aws_iam_policy_document.runtime_secrets[0].json
}

resource "aws_lb" "application" {
  for_each           = var.services
  name               = "${local.project_name}-${substr(replace(each.key, "-", ""), 0, 8)}"
  internal           = false
  load_balancer_type = "application"
  security_groups    = [aws_security_group.load_balancer[each.key].id]
  subnets            = var.public_subnet_ids
  tags               = merge(local.tags, { DeployGuardServiceId = each.key })
}
resource "aws_lb_target_group" "application" {
  for_each    = var.services
  name        = "${local.project_name}-${substr(replace(each.key, "-", ""), 0, 8)}"
  port        = var.platform_port
  protocol    = "HTTP"
  target_type = "ip"
  vpc_id      = var.vpc_id
  health_check {
    path    = "/"
    matcher = "200-399"
  }
  tags = merge(local.tags, { DeployGuardServiceId = each.key })
}
resource "aws_lb_listener" "application" {
  for_each          = var.services
  load_balancer_arn = aws_lb.application[each.key].arn
  port              = 80
  protocol          = "HTTP"
  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.application[each.key].arn
  }
}

resource "aws_ecs_task_definition" "application" {
  for_each                 = var.services
  family                   = "${local.project_name}-${substr(replace(each.key, "-", ""), 0, 8)}"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = "512"
  memory                   = "1024"
  execution_role_arn       = aws_iam_role.execution.arn
  container_definitions = jsonencode(concat([{
    name             = "application"
    image            = each.value.image
    essential        = true
    portMappings     = [{ containerPort = var.platform_port, hostPort = var.platform_port, protocol = "tcp" }]
    environment      = [for key, value in merge(each.value.environment, each.value.database_attached ? local.database_environment : {}) : { name = key, value = value }]
    secrets          = [for key, value in merge(each.value.secret_references, each.value.database_attached ? local.database_secrets : {}) : { name = key, valueFrom = value }]
    logConfiguration = { logDriver = "awslogs", options = { awslogs-group = aws_cloudwatch_log_group.application[each.key].name, awslogs-region = var.region, awslogs-stream-prefix = "application" } }
    }], each.value.database_attached ? [{
    name         = "database", image = local.database_image, essential = true
    portMappings = [{ containerPort = local.database_port, hostPort = local.database_port, protocol = "tcp" }]
    mountPoints  = [{ sourceVolume = "database", containerPath = local.database_path, readOnly = false }]
    environment  = local.database_engine == "mysql" ? [{ name = "MYSQL_DATABASE", value = "application" }, { name = "MYSQL_USER", value = "deployguard" }] : local.database_engine == "mongodb" ? [{ name = "MONGO_INITDB_DATABASE", value = "application" }, { name = "MONGO_INITDB_ROOT_USERNAME", value = "deployguard" }] : [{ name = "POSTGRES_DB", value = "application" }, { name = "POSTGRES_USER", value = "deployguard" }]
    secrets      = local.database_engine == "mysql" ? [{ name = "MYSQL_PASSWORD", valueFrom = "${aws_secretsmanager_secret.database[0].arn}:password::" }, { name = "MYSQL_ROOT_PASSWORD", valueFrom = "${aws_secretsmanager_secret.database[0].arn}:password::" }] : local.database_engine == "mongodb" ? [{ name = "MONGO_INITDB_ROOT_PASSWORD", valueFrom = "${aws_secretsmanager_secret.database[0].arn}:password::" }] : [{ name = "POSTGRES_PASSWORD", valueFrom = "${aws_secretsmanager_secret.database[0].arn}:password::" }]
  }] : []))
  dynamic "volume" {
    for_each = each.value.database_attached ? [1] : []
    content {
      name = "database"
      efs_volume_configuration {
        file_system_id     = aws_efs_file_system.database[0].id
        transit_encryption = "ENABLED"
        authorization_config {
          access_point_id = aws_efs_access_point.database[0].id
        }
      }
    }
  }
  tags = merge(local.tags, { DeployGuardServiceId = each.key })
}
resource "aws_ecs_service" "application" {
  for_each        = var.services
  name            = "${local.project_name}-${substr(replace(each.key, "-", ""), 0, 8)}"
  cluster         = aws_ecs_cluster.project.id
  task_definition = aws_ecs_task_definition.application[each.key].arn
  desired_count   = 1
  launch_type     = "FARGATE"
  network_configuration {
    subnets          = var.public_subnet_ids
    security_groups  = [aws_security_group.application[each.key].id]
    assign_public_ip = true
  }
  load_balancer {
    target_group_arn = aws_lb_target_group.application[each.key].arn
    container_name   = "application"
    container_port   = var.platform_port
  }
  depends_on = [aws_lb_listener.application, aws_iam_role_policy.runtime_secrets, aws_efs_mount_target.database]
  tags       = merge(local.tags, { DeployGuardServiceId = each.key })
}
