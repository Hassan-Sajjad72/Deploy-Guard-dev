variable "project_id" {
  type = string
}

variable "project_name" {
  type = string
}

variable "environment_name" {
  type    = string
  default = "dev"
}

variable "aws_region" {
  type = string
}

variable "vpc_cidr" {
  type    = string
  default = "10.0.0.0/16"
}

variable "public_subnet_cidrs" {
  type    = list(string)
  default = ["10.0.1.0/24", "10.0.2.0/24"]
}

variable "private_subnet_cidrs" {
  type    = list(string)
  default = ["10.0.101.0/24", "10.0.102.0/24"]
}

variable "single_nat_gateway" {
  type    = bool
  default = true
}

variable "cloud_map_namespace" {
  type = string
}

variable "enable_https" {
  type    = bool
  default = false
}

variable "app_port" {
  type    = number
  default = 3000
}

variable "tags" {
  type    = map(string)
  default = {}
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
  type    = string
  default = "/deployguard/default/dev"
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

variable "enable_ecs_service" {
  type    = bool
  default = false
}

variable "ecs_container_image" {
  type    = string
  default = ""
}

variable "ecs_container_name" {
  type    = string
  default = "app"
}

variable "ecs_task_cpu" {
  type    = number
  default = 256
}

variable "ecs_task_memory" {
  type    = number
  default = 512
}

variable "ecs_environment_variables" {
  type    = map(string)
  default = {}
}

variable "ecs_use_fargate_spot" {
  type    = bool
  default = true
}

variable "ecs_enable_fargate_fallback" {
  type    = bool
  default = false
}

variable "ecs_desired_count" {
  type    = number
  default = 1
}

variable "ecs_min_tasks" {
  type    = number
  default = 1
}

variable "ecs_max_tasks" {
  type    = number
  default = 3
}

variable "ecs_cpu_target_percent" {
  type    = number
  default = 60
}

variable "ecs_healthcheck_grace_seconds" {
  type    = number
  default = 60
}

variable "ecs_container_insights" {
  type    = bool
  default = false
}

variable "alb_health_check_path" {
  type    = string
  default = "/health"
}

variable "enable_eventbridge_spot_rule" {
  type    = bool
  default = true
}

variable "spot_event_api_destination_endpoint" {
  type    = string
  default = ""
}

variable "spot_event_api_destination_secret" {
  type      = string
  default   = ""
  sensitive = true
}
