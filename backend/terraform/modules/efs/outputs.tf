output "efs_enabled" {
  value = var.enable_efs
}

output "efs_file_system_id" {
  value = var.enable_efs ? aws_efs_file_system.this[0].id : null
}

output "efs_file_system_arn" {
  value = var.enable_efs ? aws_efs_file_system.this[0].arn : null
}

output "efs_kms_key_id" {
  value = var.enable_efs ? aws_kms_key.efs[0].key_id : null
}

output "efs_kms_key_arn" {
  value = var.enable_efs ? aws_kms_key.efs[0].arn : null
}

output "efs_access_point_id" {
  value = var.enable_efs ? aws_efs_access_point.this[0].id : null
}

output "efs_access_point_arn" {
  value = var.enable_efs ? aws_efs_access_point.this[0].arn : null
}

output "efs_security_group_id" {
  value = var.enable_efs ? aws_security_group.efs[0].id : null
}

output "efs_mount_target_ids" {
  value = var.enable_efs ? aws_efs_mount_target.this[*].id : []
}

output "efs_dns_name" {
  value = var.enable_efs ? "${aws_efs_file_system.this[0].id}.efs.${data.aws_region.current.name}.amazonaws.com" : null
}

output "efs_root_directory" {
  value = var.efs_root_directory
}

output "efs_posix_uid" {
  value = var.efs_posix_uid
}

output "efs_posix_gid" {
  value = var.efs_posix_gid
}

output "efs_root_permissions" {
  value = var.efs_root_permissions
}

output "efs_backup_vault_name" {
  value = var.enable_efs && var.enable_efs_backup ? aws_backup_vault.efs[0].name : null
}

output "efs_backup_plan_id" {
  value = var.enable_efs && var.enable_efs_backup ? aws_backup_plan.efs[0].id : null
}

output "efs_backup_enabled" {
  value = var.enable_efs && var.enable_efs_backup
}

data "aws_region" "current" {}
