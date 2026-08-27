locals {
  short_id      = substr(replace(var.project_id, "-", ""), 0, 20)
  port          = var.port
  image         = var.image
  data_path     = var.efs_mount_path
  internal_host = "${var.cloud_map_name}.${var.cloud_map_namespace_name}"
  common_tags = merge(var.tags, {
    ManagedBy            = "DeployGuard"
    DeployGuardProjectId = var.project_id
    Environment          = var.environment_name
    Tier                 = "database"
  })
}

resource "random_password" "database" {
  count            = var.enabled ? 1 : 0
  length           = 32
  special          = true
  override_special = "_-"
}

resource "aws_secretsmanager_secret" "password" {
  count                   = var.enabled ? 1 : 0
  name                    = "deployguard/${var.project_id}/${var.environment_name}/database/password"
  recovery_window_in_days = 7
  tags = merge(local.common_tags, {
    SecretPurpose        = "database_password"
    DeployGuardLifecycle = "retained"
  })
}
resource "aws_secretsmanager_secret_version" "password" {
  count         = var.enabled ? 1 : 0
  secret_id     = aws_secretsmanager_secret.password[0].id
  secret_string = random_password.database[0].result

  lifecycle {
    ignore_changes = [secret_string]
  }
}
resource "aws_secretsmanager_secret" "url" {
  count                   = var.enabled ? 1 : 0
  name                    = "deployguard/${var.project_id}/${var.environment_name}/database/url"
  recovery_window_in_days = 7
  tags = merge(local.common_tags, {
    SecretPurpose        = "database_url"
    DeployGuardLifecycle = "retained"
  })
}
resource "aws_secretsmanager_secret_version" "url" {
  count         = var.enabled ? 1 : 0
  secret_id     = aws_secretsmanager_secret.url[0].id
  secret_string = "${var.engine == "mysql" ? "mysql" : var.engine == "mongodb" ? "mongodb" : "postgresql"}://${var.database_user}:${urlencode(random_password.database[0].result)}@${local.internal_host}:${local.port}/${var.database_name}${var.engine == "mongodb" ? "?authSource=admin" : ""}"

  lifecycle {
    ignore_changes = [secret_string]
  }
}

resource "aws_security_group" "database" {
  count       = var.enabled ? 1 : 0
  name_prefix = "dg-${local.short_id}-db-"
  description = "DeployGuard managed database security group"
  vpc_id      = var.vpc_id
  ingress {
    description     = "App to database"
    from_port       = local.port
    to_port         = local.port
    protocol        = "tcp"
    security_groups = [var.app_security_group_id]
  }
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
  tags = local.common_tags
}
resource "aws_security_group" "efs" {
  count       = var.enabled && var.persistence_enabled && var.efs_enabled ? 1 : 0
  name_prefix = "dg-${local.short_id}-db-efs-"
  description = "DeployGuard managed database storage security group"
  vpc_id      = var.vpc_id
  ingress {
    description     = "Database task NFS"
    from_port       = 2049
    to_port         = 2049
    protocol        = "tcp"
    security_groups = [aws_security_group.database[0].id]
  }
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
  tags = local.common_tags
}
resource "aws_kms_key" "efs" {
  count                   = var.enabled && var.persistence_enabled && var.efs_enabled ? 1 : 0
  description             = "DeployGuard project database EFS"
  enable_key_rotation     = true
  deletion_window_in_days = 30
  tags                    = local.common_tags
}
resource "aws_efs_file_system" "database" {
  count            = var.enabled && var.persistence_enabled && var.efs_enabled ? 1 : 0
  encrypted        = true
  kms_key_id       = aws_kms_key.efs[0].arn
  performance_mode = "generalPurpose"
  throughput_mode  = "bursting"
  lifecycle_policy { transition_to_ia = "AFTER_30_DAYS" }
  tags = merge(local.common_tags, { Name = "deployguard-${var.project_id}-database" })
}
resource "aws_efs_mount_target" "database" {
  count           = var.enabled && var.persistence_enabled && var.efs_enabled ? length(var.private_subnet_ids) : 0
  file_system_id  = aws_efs_file_system.database[0].id
  subnet_id       = var.private_subnet_ids[count.index]
  security_groups = [aws_security_group.efs[0].id]
}
resource "aws_efs_access_point" "database" {
  count          = var.enabled && var.persistence_enabled && var.efs_enabled ? 1 : 0
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
      permissions = "700"
    }
  }
  tags = local.common_tags
}

resource "aws_ecs_cluster" "database" {
  count = var.enabled ? 1 : 0
  name  = "dg-${local.short_id}-${var.environment_name}-database"
  tags  = local.common_tags
}
resource "aws_cloudwatch_log_group" "database" {
  count             = var.enabled ? 1 : 0
  name              = "/deployguard/${var.project_id}/${var.environment_name}/database"
  retention_in_days = 14
  tags = merge(local.common_tags, {
    LogPurpose = "database"
  })
}
data "aws_iam_policy_document" "assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}
resource "aws_iam_role" "execution" {
  count              = var.enabled ? 1 : 0
  name               = "dg-${local.short_id}-${var.environment_name}-db-exec"
  assume_role_policy = data.aws_iam_policy_document.assume.json
  tags               = local.common_tags
}
resource "aws_iam_role_policy_attachment" "execution" {
  count      = var.enabled ? 1 : 0
  role       = aws_iam_role.execution[0].name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}
resource "aws_iam_role_policy" "password" {
  count  = var.enabled ? 1 : 0
  name   = "database-secret"
  role   = aws_iam_role.execution[0].id
  policy = jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow", Action = ["secretsmanager:GetSecretValue"], Resource = [aws_secretsmanager_secret.password[0].arn] }] })
}
resource "aws_iam_role" "task" {
  count              = var.enabled ? 1 : 0
  name               = "dg-${local.short_id}-${var.environment_name}-db-task"
  assume_role_policy = data.aws_iam_policy_document.assume.json
  tags               = local.common_tags
}
resource "aws_iam_role_policy" "efs" {
  count  = var.enabled && var.persistence_enabled && var.efs_enabled ? 1 : 0
  name   = "database-efs"
  role   = aws_iam_role.task[0].id
  policy = jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow", Action = ["elasticfilesystem:ClientMount", "elasticfilesystem:ClientWrite"], Resource = [aws_efs_file_system.database[0].arn] }] })
}
resource "aws_service_discovery_service" "database" {
  count = var.enabled ? 1 : 0
  name  = var.cloud_map_name
  dns_config {
    namespace_id = var.cloud_map_namespace_id
    dns_records {
      ttl  = 10
      type = "A"
    }
    routing_policy = "MULTIVALUE"
  }
  health_check_custom_config { failure_threshold = 1 }
  tags = local.common_tags
}
resource "aws_ecs_task_definition" "database" {
  count                    = var.enabled ? 1 : 0
  family                   = "dg-${local.short_id}-${var.environment_name}-database"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = tostring(var.task_cpu)
  memory                   = tostring(var.task_memory)
  execution_role_arn       = aws_iam_role.execution[0].arn
  task_role_arn            = aws_iam_role.task[0].arn
  container_definitions = jsonencode([{
    name         = "database"
    image        = local.image
    essential    = true
    portMappings = [{ containerPort = local.port, hostPort = local.port, protocol = "tcp" }]
    environment  = var.engine == "mysql" ? [{ name = "MYSQL_DATABASE", value = var.database_name }, { name = "MYSQL_USER", value = var.database_user }] : var.engine == "mongodb" ? [{ name = "MONGO_INITDB_DATABASE", value = var.database_name }, { name = "MONGO_INITDB_ROOT_USERNAME", value = var.database_user }] : [{ name = "POSTGRES_DB", value = var.database_name }, { name = "POSTGRES_USER", value = var.database_user }]
    secrets      = var.engine == "mysql" ? [{ name = "MYSQL_PASSWORD", valueFrom = aws_secretsmanager_secret.password[0].arn }, { name = "MYSQL_ROOT_PASSWORD", valueFrom = aws_secretsmanager_secret.password[0].arn }] : var.engine == "mongodb" ? [{ name = "MONGO_INITDB_ROOT_PASSWORD", valueFrom = aws_secretsmanager_secret.password[0].arn }] : [{ name = "POSTGRES_PASSWORD", valueFrom = aws_secretsmanager_secret.password[0].arn }]
    healthCheck = var.engine == "mysql" ? {
      command     = ["CMD-SHELL", "mysqladmin ping -h 127.0.0.1 -P ${local.port} --silent || exit 1"]
      interval    = 10
      timeout     = 5
      retries     = 6
      startPeriod = 30
      } : var.engine == "mongodb" ? {
      command     = ["CMD-SHELL", "mongosh --quiet --username \"$MONGO_INITDB_ROOT_USERNAME\" --password \"$MONGO_INITDB_ROOT_PASSWORD\" --authenticationDatabase admin --eval 'db.adminCommand({ ping: 1 })' >/dev/null || exit 1"]
      interval    = 10
      timeout     = 5
      retries     = 6
      startPeriod = 30
      } : {
      command     = ["CMD-SHELL", "pg_isready -h 127.0.0.1 -p ${local.port} -U ${var.database_user} -d ${var.database_name} || exit 1"]
      interval    = 10
      timeout     = 5
      retries     = 6
      startPeriod = 30
    }
    mountPoints      = var.persistence_enabled && var.efs_enabled ? [{ sourceVolume = "database-data", containerPath = local.data_path, readOnly = false }] : []
    logConfiguration = { logDriver = "awslogs", options = { awslogs-group = aws_cloudwatch_log_group.database[0].name, awslogs-region = var.aws_region, awslogs-stream-prefix = "ecs" } }
  }])
  dynamic "volume" {
    for_each = var.persistence_enabled && var.efs_enabled ? [1] : []
    content {
      name = "database-data"
      efs_volume_configuration {
        file_system_id     = aws_efs_file_system.database[0].id
        transit_encryption = "ENABLED"
        authorization_config {
          access_point_id = aws_efs_access_point.database[0].id
          iam             = "ENABLED"
        }
      }
    }
  }
  tags = local.common_tags
}
resource "aws_ecs_service" "database" {
  count           = var.enabled ? 1 : 0
  name            = "database"
  cluster         = aws_ecs_cluster.database[0].id
  task_definition = aws_ecs_task_definition.database[0].arn
  desired_count   = 1
  launch_type     = "FARGATE"
  network_configuration {
    subnets          = var.private_subnet_ids
    security_groups  = [aws_security_group.database[0].id]
    assign_public_ip = false
  }
  service_registries { registry_arn = aws_service_discovery_service.database[0].arn }
  tags       = local.common_tags
  depends_on = [aws_efs_mount_target.database, aws_iam_role_policy_attachment.execution]
}
resource "aws_backup_vault" "database" {
  count       = var.enabled && var.persistence_enabled && var.efs_enabled && var.backup_enabled ? 1 : 0
  name        = "dg-${local.short_id}-${var.environment_name}-database"
  kms_key_arn = aws_kms_key.efs[0].arn
  tags        = local.common_tags
}
data "aws_iam_policy_document" "backup_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["backup.amazonaws.com"]
    }
  }
}
resource "aws_iam_role" "backup" {
  count              = var.enabled && var.persistence_enabled && var.efs_enabled && var.backup_enabled ? 1 : 0
  name               = "dg-${local.short_id}-${var.environment_name}-db-backup"
  assume_role_policy = data.aws_iam_policy_document.backup_assume.json
  tags               = local.common_tags
}
resource "aws_iam_role_policy_attachment" "backup" {
  count      = var.enabled && var.persistence_enabled && var.efs_enabled && var.backup_enabled ? 1 : 0
  role       = aws_iam_role.backup[0].name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSBackupServiceRolePolicyForBackup"
}
resource "aws_backup_plan" "database" {
  count = var.enabled && var.persistence_enabled && var.efs_enabled && var.backup_enabled ? 1 : 0
  name  = "dg-${local.short_id}-${var.environment_name}-database"
  rule {
    rule_name         = "daily"
    target_vault_name = aws_backup_vault.database[0].name
    schedule          = "cron(0 3 * * ? *)"
    lifecycle { delete_after = 30 }
  }
  tags = local.common_tags
}
resource "aws_backup_selection" "database" {
  count        = var.enabled && var.persistence_enabled && var.efs_enabled && var.backup_enabled ? 1 : 0
  name         = "database-efs"
  plan_id      = aws_backup_plan.database[0].id
  iam_role_arn = aws_iam_role.backup[0].arn
  resources    = [aws_efs_file_system.database[0].arn]
}
