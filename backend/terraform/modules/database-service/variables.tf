variable "project_id" { type = string }
variable "environment_name" { type = string }
variable "aws_region" { type = string }
variable "enabled" {
  type    = bool
  default = false
}
variable "engine" {
  type    = string
  default = "postgres"
  validation {
    condition     = contains(["postgres", "mysql", "mongodb"], var.engine)
    error_message = "Database engine must be postgres, mysql, or mongodb."
  }
}
variable "image" { type = string }
variable "port" { type = number }
variable "task_cpu" { type = number }
variable "task_memory" { type = number }
variable "database_name" {
  type    = string
  default = "app"
}
variable "database_user" {
  type    = string
  default = "deployguard"
}
variable "private_subnet_ids" { type = list(string) }
variable "vpc_id" { type = string }
variable "app_security_group_id" { type = string }
variable "cloud_map_namespace_id" { type = string }
variable "cloud_map_namespace_name" { type = string }
variable "persistence_enabled" {
  type    = bool
  default = true
}
variable "efs_enabled" { type = bool }
variable "efs_mount_path" { type = string }
variable "cloud_map_name" { type = string }
variable "backup_enabled" {
  type    = bool
  default = true
}
variable "tags" {
  type    = map(string)
  default = {}
}
