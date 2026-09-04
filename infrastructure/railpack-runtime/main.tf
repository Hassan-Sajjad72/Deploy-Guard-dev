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
  project_name                = "dg-${substr(replace(var.project_id, "-", ""), 0, 12)}"
  database_services           = { for id, service in var.services : id => service if service.database_attached }
  database_enabled            = length(local.database_services) == 1
  database_service_id         = local.database_enabled ? keys(local.database_services)[0] : null
  database_service            = local.database_enabled ? values(local.database_services)[0] : null
  database_engine             = local.database_enabled ? local.database_service.managed_database_engine : "postgres"
  database_aliases            = local.database_enabled ? local.database_service.managed_database_aliases : []
  database_port               = local.database_engine == "mysql" ? 3306 : local.database_engine == "mongodb" ? 27017 : 5432
  database_image              = local.database_engine == "mysql" ? "mysql:8" : local.database_engine == "mongodb" ? "mongo:8" : "postgres:16"
  database_path               = local.database_engine == "mysql" ? "/var/lib/mysql" : local.database_engine == "mongodb" ? "/data/db" : "/var/lib/postgresql/data"
  database_health_check       = local.database_engine == "mysql" ? ["CMD-SHELL", "mysqladmin ping -h 127.0.0.1 -u\"$MYSQL_USER\" -p\"$MYSQL_PASSWORD\" --silent"] : local.database_engine == "mongodb" ? ["CMD-SHELL", "mongosh --quiet --username \"$MONGO_INITDB_ROOT_USERNAME\" --password \"$MONGO_INITDB_ROOT_PASSWORD\" --authenticationDatabase admin --eval 'db.adminCommand({ ping: 1 })' >/dev/null"] : ["CMD-SHELL", "pg_isready -U $POSTGRES_USER -d $POSTGRES_DB"]
  mysql_grant_reconciler_name = "deployguard-mysql-grant-reconciler"
  mysql_grant_reconciler_command = ["sh", "-ec", <<-EOT
    set -eu
    ready=false
    for _ in $$(seq 1 90); do
      if MYSQL_PWD="$$MYSQL_ROOT_PASSWORD" mysqladmin --protocol=TCP -h 127.0.0.1 -uroot ping --silent; then ready=true; break; fi
      sleep 2
    done
    [ "$$ready" = true ] || exit 1
    MYSQL_PWD="$$MYSQL_ROOT_PASSWORD" mysql --protocol=TCP -h 127.0.0.1 -uroot -e "CREATE USER IF NOT EXISTS 'deployguard'@'%' IDENTIFIED BY '$$MYSQL_PASSWORD'; ALTER USER 'deployguard'@'%' IDENTIFIED BY '$$MYSQL_PASSWORD'; GRANT ALL PRIVILEGES ON \`application\`.* TO 'deployguard'@'%'; FLUSH PRIVILEGES;"
    MYSQL_PWD="$$MYSQL_PASSWORD" mysql --protocol=TCP -h 127.0.0.1 -udeployguard -e "SELECT 1" application
  EOT
  ]
  database_host              = local.database_enabled ? "database.${local.project_name}.internal" : ""
  platform_health_check_path = "/_deployguard/transport-ready"
  transport_probe_image      = "public.ecr.aws/docker/library/busybox:1.36.1@sha256:73aaf090f3d85aa34ee199857f03fa3a95c8ede2ffd4cc2cdb5b94e566b11662"
  transport_probe_ports = {
    for id, service in var.services : id => service.service_port == 65535 ? 65534 : 65535
  }
  tags = {
    ManagedBy              = "DeployGuard"
    DeployGuardProjectId   = var.project_id
    DeployGuardOperationId = var.operation_id
  }
  database_tags = {
    ManagedBy            = "DeployGuard"
    DeployGuardProjectId = var.project_id
    DeployGuardResource  = "managed-database"
  }
  runtime_secret_arns = distinct(concat(
    flatten([for service in values(var.services) : [for reference in values(service.secret_references) : join(":", slice(split(":", reference), 0, 7))]]),
    local.database_enabled ? [aws_secretsmanager_secret.database[0].arn] : [],
  ))
  # Resource cardinality must be decided exclusively from configuration known
  # during planning. The managed database secret ARN is intentionally allowed
  # to remain unknown until apply inside the resulting policy document.
  runtime_secrets_enabled = local.database_enabled || anytrue([
    for service in values(var.services) : length(keys(service.secret_references)) > 0
  ])
  database_environment = local.database_enabled ? {
    for key in local.database_aliases : key => contains(["DB_PORT", "DATABASE_PORT", "POSTGRES_PORT", "PGPORT", "MYSQL_PORT", "MONGO_PORT", "MONGODB_PORT"], key) ? tostring(local.database_port) : contains(["DB_HOST", "DATABASE_HOST", "POSTGRES_HOST", "PGHOST", "MYSQL_HOST", "MONGO_HOST", "MONGODB_HOST"], key) ? local.database_host : contains(["DB_USER", "DATABASE_USER", "POSTGRES_USER", "PGUSER", "MYSQL_USER", "MONGO_USER", "MONGODB_USER"], key) ? "deployguard" : "application"
    if !contains(["DB_PASSWORD", "DATABASE_PASSWORD", "POSTGRES_PASSWORD", "PGPASSWORD", "MYSQL_PASSWORD", "MONGO_PASSWORD", "MONGODB_PASSWORD", "DATABASE_URL", "POSTGRES_URL", "POSTGRESQL_URL", "MYSQL_URL", "MONGO_URI", "MONGO_URL", "MONGODB_URI"], key)
  } : {}
  database_secrets = local.database_enabled ? {
    for key in local.database_aliases : key => "${aws_secretsmanager_secret.database[0].arn}:${contains(["DATABASE_URL", "POSTGRES_URL", "POSTGRESQL_URL", "MYSQL_URL", "MONGO_URI", "MONGO_URL", "MONGODB_URI"], key) ? "url" : "password"}::${aws_secretsmanager_secret_version.database[0].version_id}"
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
resource "aws_cloudwatch_log_group" "database" {
  count             = local.database_enabled ? 1 : 0
  name              = "/deployguard/${var.project_id}/database"
  retention_in_days = 14
  tags              = local.database_tags
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
    from_port       = each.value.service_port
    to_port         = each.value.service_port
    protocol        = "tcp"
    security_groups = [aws_security_group.load_balancer[each.key].id]
  }
  ingress {
    from_port       = local.transport_probe_ports[each.key]
    to_port         = local.transport_probe_ports[each.key]
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

resource "aws_security_group" "database_runtime" {
  count       = local.database_enabled ? 1 : 0
  name_prefix = "${local.project_name}-database-"
  vpc_id      = var.vpc_id
  ingress {
    from_port       = local.database_port
    to_port         = local.database_port
    protocol        = "tcp"
    security_groups = local.database_enabled ? [aws_security_group.application[local.database_service_id].id] : []
  }
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
  tags = local.database_tags
}
resource "aws_security_group" "database_efs" {
  count       = local.database_enabled ? 1 : 0
  name_prefix = "${local.project_name}-database-efs-"
  vpc_id      = var.vpc_id
  ingress {
    from_port       = 2049
    to_port         = 2049
    protocol        = "tcp"
    security_groups = [aws_security_group.database_runtime[0].id]
  }
  tags = local.database_tags
}
resource "aws_efs_file_system" "database" {
  count           = local.database_enabled ? 1 : 0
  encrypted       = true
  throughput_mode = "bursting"
  tags            = local.database_tags
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
  tags = local.database_tags
}
resource "aws_efs_mount_target" "database" {
  for_each        = local.database_enabled ? toset(var.public_subnet_ids) : toset([])
  file_system_id  = aws_efs_file_system.database[0].id
  subnet_id       = each.value
  security_groups = [aws_security_group.database_efs[0].id]
}
resource "random_password" "database" {
  count   = local.database_enabled ? 1 : 0
  length  = 32
  special = false
}
resource "aws_secretsmanager_secret" "database" {
  count = local.database_enabled ? 1 : 0
  name  = "deployguard/${var.project_id}/database"
  tags  = local.database_tags
}
resource "aws_secretsmanager_secret_version" "database" {
  count     = local.database_enabled ? 1 : 0
  secret_id = aws_secretsmanager_secret.database[0].id
  secret_string = jsonencode({
    password = random_password.database[0].result
    url      = "${local.database_engine == "mysql" ? "mysql" : local.database_engine == "mongodb" ? "mongodb" : "postgresql"}://deployguard:${random_password.database[0].result}@${local.database_host}:${local.database_port}/application${local.database_engine == "mongodb" ? "?authSource=admin" : ""}"
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
  count = local.runtime_secrets_enabled ? 1 : 0
  statement {
    actions   = ["secretsmanager:GetSecretValue"]
    resources = local.runtime_secret_arns
  }
}
resource "aws_iam_role_policy" "runtime_secrets" {
  count  = local.runtime_secrets_enabled ? 1 : 0
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
  name        = "${local.project_name}-${substr(replace(each.key, "-", ""), 0, 8)}-${each.value.service_port}"
  port        = each.value.service_port
  protocol    = "HTTP"
  target_type = "ip"
  vpc_id      = var.vpc_id
  health_check {
    path    = local.platform_health_check_path
    port    = tostring(local.transport_probe_ports[each.key])
    matcher = "200-299"
  }
  lifecycle {
    create_before_destroy = true
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
  container_definitions = jsonencode([
    {
      name             = "application"
      image            = each.value.image
      essential        = true
      portMappings     = [{ containerPort = each.value.service_port, hostPort = each.value.service_port, protocol = "tcp" }]
      environment      = [for key, value in merge(each.value.environment, each.value.database_attached ? local.database_environment : {}) : { name = key, value = value }]
      secrets          = [for key, value in merge(each.value.secret_references, each.value.database_attached ? local.database_secrets : {}) : { name = key, valueFrom = value }]
      logConfiguration = { logDriver = "awslogs", options = { awslogs-group = aws_cloudwatch_log_group.application[each.key].name, awslogs-region = var.region, awslogs-stream-prefix = "application" } }
    },
    {
      name         = "deployguard-transport-probe"
      image        = local.transport_probe_image
      essential    = true
      portMappings = [{ containerPort = local.transport_probe_ports[each.key], hostPort = local.transport_probe_ports[each.key], protocol = "tcp" }]
      environment = [
        { name = "APPLICATION_PORT", value = tostring(each.value.service_port) },
        { name = "PROBE_PORT", value = tostring(local.transport_probe_ports[each.key]) },
      ]
      command          = ["sh", "-ec", "while true; do if nc -z -w 1 127.0.0.1 \"$APPLICATION_PORT\"; then printf 'HTTP/1.1 204 No Content\\r\\nContent-Length: 0\\r\\nConnection: close\\r\\n\\r\\n' | nc -l -p \"$PROBE_PORT\" -w 2 || true; else sleep 1; fi; done"]
      logConfiguration = { logDriver = "awslogs", options = { awslogs-group = aws_cloudwatch_log_group.application[each.key].name, awslogs-region = var.region, awslogs-stream-prefix = "deployguard-transport-probe" } }
    }
  ])
  tags = merge(local.tags, { DeployGuardServiceId = each.key, DeployGuardRuntimeConfigRevisionId = each.value.runtime_config_revision_id })
}

resource "aws_service_discovery_private_dns_namespace" "database" {
  count = local.database_enabled ? 1 : 0
  name  = "${local.project_name}.internal"
  vpc   = var.vpc_id
  tags  = local.database_tags
}
resource "aws_service_discovery_service" "database" {
  count = local.database_enabled ? 1 : 0
  name  = "database"
  dns_config {
    namespace_id = aws_service_discovery_private_dns_namespace.database[0].id
    dns_records {
      ttl  = 10
      type = "A"
    }
    routing_policy = "MULTIVALUE"
  }
  health_check_custom_config { failure_threshold = 1 }
  tags = local.database_tags
}
resource "aws_ecs_task_definition" "database" {
  count                    = local.database_enabled ? 1 : 0
  family                   = "${local.project_name}-database"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = "512"
  memory                   = "1024"
  execution_role_arn       = aws_iam_role.execution.arn
  container_definitions = jsonencode(concat([{
    name         = "database"
    image        = local.database_image
    essential    = true
    portMappings = [{ containerPort = local.database_port, hostPort = local.database_port, protocol = "tcp" }]
    mountPoints  = [{ sourceVolume = "database", containerPath = local.database_path, readOnly = false }]
    environment  = local.database_engine == "mysql" ? [{ name = "MYSQL_DATABASE", value = "application" }, { name = "MYSQL_USER", value = "deployguard" }] : local.database_engine == "mongodb" ? [{ name = "MONGO_INITDB_DATABASE", value = "application" }, { name = "MONGO_INITDB_ROOT_USERNAME", value = "deployguard" }] : [{ name = "POSTGRES_DB", value = "application" }, { name = "POSTGRES_USER", value = "deployguard" }]
    secrets      = local.database_engine == "mysql" ? [{ name = "MYSQL_PASSWORD", valueFrom = "${aws_secretsmanager_secret.database[0].arn}:password::${aws_secretsmanager_secret_version.database[0].version_id}" }, { name = "MYSQL_ROOT_PASSWORD", valueFrom = "${aws_secretsmanager_secret.database[0].arn}:password::${aws_secretsmanager_secret_version.database[0].version_id}" }] : local.database_engine == "mongodb" ? [{ name = "MONGO_INITDB_ROOT_PASSWORD", valueFrom = "${aws_secretsmanager_secret.database[0].arn}:password::${aws_secretsmanager_secret_version.database[0].version_id}" }] : [{ name = "POSTGRES_PASSWORD", valueFrom = "${aws_secretsmanager_secret.database[0].arn}:password::${aws_secretsmanager_secret_version.database[0].version_id}" }]
    healthCheck = {
      command     = local.database_health_check
      interval    = 5
      timeout     = 5
      retries     = 3
      startPeriod = 30
    }
    logConfiguration = { logDriver = "awslogs", options = { awslogs-group = aws_cloudwatch_log_group.database[0].name, awslogs-region = var.region, awslogs-stream-prefix = "database" } }
    }], local.database_engine == "mysql" ? [{
    name             = local.mysql_grant_reconciler_name
    image            = local.database_image
    essential        = false
    dependsOn        = [{ containerName = "database", condition = "HEALTHY" }]
    command          = local.mysql_grant_reconciler_command
    secrets          = [{ name = "MYSQL_PASSWORD", valueFrom = "${aws_secretsmanager_secret.database[0].arn}:password::${aws_secretsmanager_secret_version.database[0].version_id}" }, { name = "MYSQL_ROOT_PASSWORD", valueFrom = "${aws_secretsmanager_secret.database[0].arn}:password::${aws_secretsmanager_secret_version.database[0].version_id}" }]
    logConfiguration = { logDriver = "awslogs", options = { awslogs-group = aws_cloudwatch_log_group.database[0].name, awslogs-region = var.region, awslogs-stream-prefix = "mysql-grant-reconciler" } }
  }] : []))
  volume {
    name = "database"
    efs_volume_configuration {
      file_system_id     = aws_efs_file_system.database[0].id
      transit_encryption = "ENABLED"
      authorization_config { access_point_id = aws_efs_access_point.database[0].id }
    }
  }
  tags = local.database_tags
}
resource "aws_ecs_service" "database" {
  count           = local.database_enabled ? 1 : 0
  name            = "${local.project_name}-database"
  cluster         = aws_ecs_cluster.project.id
  task_definition = aws_ecs_task_definition.database[0].arn
  desired_count   = 1
  launch_type     = "FARGATE"
  network_configuration {
    subnets         = var.public_subnet_ids
    security_groups = [aws_security_group.database_runtime[0].id]
    # The configured platform subnets are public; the database remains private
    # because its security group accepts only the attached application SG.
    assign_public_ip = true
  }
  service_registries { registry_arn = aws_service_discovery_service.database[0].arn }
  depends_on = [aws_efs_mount_target.database, aws_iam_role_policy.runtime_secrets]
  tags       = local.database_tags
}
resource "aws_ecs_service" "application" {
  for_each        = var.services
  name            = "${local.project_name}-${substr(replace(each.key, "-", ""), 0, 8)}"
  cluster         = aws_ecs_cluster.project.id
  task_definition = aws_ecs_task_definition.application[each.key].arn
  desired_count   = each.value.database_attached ? 0 : 1
  launch_type     = "FARGATE"
  network_configuration {
    subnets          = var.public_subnet_ids
    security_groups  = [aws_security_group.application[each.key].id]
    assign_public_ip = true
  }
  load_balancer {
    target_group_arn = aws_lb_target_group.application[each.key].arn
    container_name   = "application"
    container_port   = each.value.service_port
  }
  lifecycle {
    ignore_changes = [desired_count]
  }
  depends_on = [aws_lb_listener.application, aws_iam_role_policy.runtime_secrets]
  tags       = merge(local.tags, { DeployGuardServiceId = each.key })
}
