variable "project_id" {
  type = string
}

variable "project_name" {
  type = string
}

variable "environment_name" {
  type = string
}

variable "aws_region" {
  type = string
}

variable "enable_ecs_service" {
  type    = bool
  default = false
}

variable "container_image" {
  type    = string
  default = ""
}

variable "container_name" {
  type    = string
  default = "app"
}

variable "container_port" {
  type = number
}

variable "task_cpu" {
  type    = number
  default = 256
}

variable "task_memory" {
  type    = number
  default = 512
}

variable "environment_variables" {
  type    = map(string)
  default = {}
}

variable "efs_enabled" {
  type    = bool
  default = false
}

variable "efs_file_system_id" {
  type    = string
  default = null
}

variable "efs_access_point_id" {
  type    = string
  default = null
}

variable "efs_container_path" {
  type    = string
  default = "/app/data"
}

variable "private_subnet_ids" {
  type = list(string)
}

variable "app_security_group_id" {
  type = string
}

variable "target_group_arn" {
  type    = string
  default = null
}

variable "cloud_map_namespace_id" {
  type    = string
  default = null
}

variable "use_fargate_spot" {
  type    = bool
  default = true
}

variable "enable_fargate_fallback" {
  type    = bool
  default = false
}

variable "desired_count" {
  type    = number
  default = 1
}

variable "min_tasks" {
  type    = number
  default = 1
}

variable "max_tasks" {
  type    = number
  default = 3
}

variable "cpu_target_percent" {
  type    = number
  default = 60
}

variable "health_check_grace_seconds" {
  type    = number
  default = 60
}

variable "enable_container_insights" {
  type    = bool
  default = false
}

variable "tags" {
  type    = map(string)
  default = {}
}
