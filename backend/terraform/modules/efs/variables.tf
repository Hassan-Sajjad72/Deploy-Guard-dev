variable "project_id" {
  type = string
}

variable "environment_name" {
  type = string
}

variable "vpc_id" {
  type = string
}

variable "private_subnet_ids" {
  type = list(string)
}

variable "app_security_group_id" {
  type = string
}

variable "internal_security_group_id" {
  type = string
}

variable "enable_efs" {
  type    = bool
  default = false
}

variable "efs_performance_mode" {
  type    = string
  default = "generalPurpose"
}

variable "efs_throughput_mode" {
  type    = string
  default = "bursting"
}

variable "efs_transition_to_ia" {
  type    = string
  default = "AFTER_30_DAYS"
}

variable "efs_posix_uid" {
  type    = number
  default = 1000
}

variable "efs_posix_gid" {
  type    = number
  default = 1000
}

variable "efs_root_permissions" {
  type    = string
  default = "750"
}

variable "efs_root_directory" {
  type = string
}

variable "enable_efs_backup" {
  type    = bool
  default = true
}

variable "efs_backup_retention_days" {
  type    = number
  default = 30
}

variable "efs_backup_schedule" {
  type    = string
  default = "cron(0 3 * * ? *)"
}

variable "tags" {
  type = map(string)
}
