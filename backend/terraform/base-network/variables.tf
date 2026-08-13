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

variable "nat_mode" {
  type    = string
  default = null

  validation {
    condition     = var.nat_mode == null || contains(["none", "single", "per_az"], var.nat_mode)
    error_message = "nat_mode must be none, single, or per_az when set."
  }
}

variable "availability_zone_names" {
  type    = list(string)
  default = []
}

variable "offline_plan_mode" {
  type    = bool
  default = false
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

variable "manage_ecr_repository" {
  type    = bool
  default = false
}

variable "ecr_repository_name" {
  type    = string
  default = ""
}

variable "ecr_image_tag_mutability" {
  type    = string
  default = "IMMUTABLE"
}

variable "enable_cloud_map" {
  type    = bool
  default = true
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

variable "enable_ecs_foundation" {
  description = "Creates release-independent ECS cluster, roles, and log group without an application task definition or service."
  type        = bool
  default     = false
}

variable "enable_ecs_foundation_service" {
  type    = bool
  default = false
}

variable "ecs_baseline_container_image" {
  type    = string
  default = ""
}

variable "ecs_egress_strategy" {
  type    = string
  default = "nat"

  validation {
    condition     = contains(["nat", "public_ip"], var.ecs_egress_strategy)
    error_message = "ecs_egress_strategy must be nat or public_ip."
  }
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

variable "ecs_secret_environment_variables" {
  type      = map(string)
  default   = {}
  sensitive = true
}

variable "database_secret_alias_types" {
  description = "Application environment aliases mapped to managed database secret outputs."
  type        = map(string)
  default     = {}

  validation {
    condition     = alltrue([for value in values(var.database_secret_alias_types) : contains(["password", "url"], value)])
    error_message = "Managed database secret alias types must be password or url."
  }
}

variable "database_service" {
  type = object({
    enabled             = bool
    engine              = string
    image               = string
    port                = number
    cpu                 = number
    memory              = number
    database_name       = string
    database_user       = string
    efs_enabled         = bool
    efs_mount_path      = string
    cloud_map_name      = string
    persistence_enabled = bool
    backup_enabled      = bool
  })
  default = {
    enabled             = false
    engine              = "postgres"
    image               = "postgres:16"
    port                = 5432
    cpu                 = 512
    memory              = 1024
    database_name       = "app"
    database_user       = "deployguard"
    efs_enabled         = true
    efs_mount_path      = "/var/lib/postgresql/data"
    cloud_map_name      = "db"
    persistence_enabled = true
    backup_enabled      = true
  }
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

variable "ecs_enable_autoscaling" {
  type    = bool
  default = true
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
