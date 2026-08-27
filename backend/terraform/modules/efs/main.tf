locals {
  short_project_id = substr(replace(var.project_id, "-", ""), 0, 20)
  backup_name      = "dg-${local.short_project_id}-${var.environment_name}-efs"
}

resource "aws_kms_key" "efs" {
  count = var.enable_efs ? 1 : 0

  description             = "DeployGuard EFS encryption key for ${var.project_id}/${var.environment_name}"
  deletion_window_in_days = 30
  enable_key_rotation     = true

  tags = merge(var.tags, {
    Name                 = "${var.project_id}-${var.environment_name}-efs-kms"
    ManagedBy            = "DeployGuard"
    DeployGuardProjectId = var.project_id
    Environment          = var.environment_name
  })
}

resource "aws_kms_alias" "efs" {
  count = var.enable_efs ? 1 : 0

  name          = "alias/deployguard/${var.project_id}/${var.environment_name}/efs"
  target_key_id = aws_kms_key.efs[0].key_id
}

resource "aws_security_group" "efs" {
  count = var.enable_efs ? 1 : 0

  name_prefix = "deployguard-${var.environment_name}-efs-"
  description = "DeployGuard EFS NFS access"
  vpc_id      = var.vpc_id

  ingress {
    description     = "NFS from app security group"
    from_port       = 2049
    to_port         = 2049
    protocol        = "tcp"
    security_groups = [var.app_security_group_id]
  }

  ingress {
    description     = "NFS from internal service security group"
    from_port       = 2049
    to_port         = 2049
    protocol        = "tcp"
    security_groups = [var.internal_security_group_id]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = merge(var.tags, {
    Name                 = "${var.project_id}-${var.environment_name}-efs-sg"
    ManagedBy            = "DeployGuard"
    DeployGuardProjectId = var.project_id
    Environment          = var.environment_name
    Persistent           = "true"
  })
}

resource "aws_efs_file_system" "this" {
  count = var.enable_efs ? 1 : 0

  encrypted        = true
  kms_key_id       = aws_kms_key.efs[0].arn
  performance_mode = var.efs_performance_mode
  throughput_mode  = var.efs_throughput_mode

  lifecycle_policy {
    transition_to_ia = var.efs_transition_to_ia
  }

  tags = merge(var.tags, {
    Name                 = "${var.project_id}-${var.environment_name}-efs"
    ManagedBy            = "DeployGuard"
    DeployGuardProjectId = var.project_id
    Environment          = var.environment_name
    Persistent           = "true"
  })
}

resource "aws_efs_mount_target" "this" {
  count = var.enable_efs ? length(var.private_subnet_ids) : 0

  file_system_id  = aws_efs_file_system.this[0].id
  subnet_id       = var.private_subnet_ids[count.index]
  security_groups = [aws_security_group.efs[0].id]
}

resource "aws_efs_access_point" "this" {
  count = var.enable_efs ? 1 : 0

  file_system_id = aws_efs_file_system.this[0].id

  posix_user {
    uid = var.efs_posix_uid
    gid = var.efs_posix_gid
  }

  root_directory {
    path = var.efs_root_directory

    creation_info {
      owner_uid   = var.efs_posix_uid
      owner_gid   = var.efs_posix_gid
      permissions = var.efs_root_permissions
    }
  }

  tags = merge(var.tags, {
    Name                 = "${var.project_id}-${var.environment_name}-efs-ap"
    ManagedBy            = "DeployGuard"
    DeployGuardProjectId = var.project_id
    Environment          = var.environment_name
    Persistent           = "true"
  })
}

resource "aws_backup_vault" "efs" {
  count = var.enable_efs && var.enable_efs_backup ? 1 : 0

  name          = local.backup_name
  kms_key_arn   = aws_kms_key.efs[0].arn
  force_destroy = true

  tags = merge(var.tags, {
    ManagedBy            = "DeployGuard"
    DeployGuardProjectId = var.project_id
    Environment          = var.environment_name
  })
}

resource "aws_iam_role" "backup" {
  count = var.enable_efs && var.enable_efs_backup ? 1 : 0

  name = "${local.backup_name}-backup"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = "sts:AssumeRole"
        Effect = "Allow"
        Principal = {
          Service = "backup.amazonaws.com"
        }
      }
    ]
  })

  tags = var.tags
}

resource "aws_iam_role_policy_attachment" "backup" {
  count = var.enable_efs && var.enable_efs_backup ? 1 : 0

  role       = aws_iam_role.backup[0].name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSBackupServiceRolePolicyForBackup"
}

resource "aws_backup_plan" "efs" {
  count = var.enable_efs && var.enable_efs_backup ? 1 : 0

  name = local.backup_name

  rule {
    rule_name         = "daily"
    target_vault_name = aws_backup_vault.efs[0].name
    schedule          = var.efs_backup_schedule

    lifecycle {
      delete_after = var.efs_backup_retention_days
    }
  }

  tags = var.tags
}

resource "aws_backup_selection" "efs" {
  count = var.enable_efs && var.enable_efs_backup ? 1 : 0

  iam_role_arn = aws_iam_role.backup[0].arn
  name         = local.backup_name
  plan_id      = aws_backup_plan.efs[0].id
  resources    = [aws_efs_file_system.this[0].arn]
}
