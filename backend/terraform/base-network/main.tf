locals {
  effective_nat_mode     = var.nat_mode == null ? (var.single_nat_gateway ? "single" : "per_az") : var.nat_mode
  ecs_foundation_enabled = var.enable_ecs_foundation || var.enable_ecs_service || var.enable_ecs_foundation_service
  ecs_subnet_ids         = var.ecs_egress_strategy == "public_ip" ? module.network.public_subnet_ids : module.network.private_subnet_ids
}

module "network" {
  source = "../modules/network"

  project_id              = var.project_id
  project_name            = var.project_name
  environment_name        = var.environment_name
  vpc_cidr                = var.vpc_cidr
  public_subnet_cidrs     = var.public_subnet_cidrs
  private_subnet_cidrs    = var.private_subnet_cidrs
  nat_mode                = local.effective_nat_mode
  availability_zone_names = var.availability_zone_names
  enable_https            = var.enable_https
  app_port                = var.app_port
  tags                    = var.tags
}

module "cloud_map" {
  count  = var.enable_cloud_map ? 1 : 0
  source = "../modules/cloud-map"

  project_id           = var.project_id
  environment_name     = var.environment_name
  vpc_id               = module.network.vpc_id
  namespace_name       = var.cloud_map_namespace
  default_service_name = "app"
  tags                 = var.tags
}

module "registry" {
  source = "../modules/registry"

  enabled              = var.manage_ecr_repository
  repository_name      = var.ecr_repository_name
  image_tag_mutability = var.ecr_image_tag_mutability
  tags                 = var.tags
}

module "efs" {
  source = "../modules/efs"

  project_id                 = var.project_id
  environment_name           = var.environment_name
  vpc_id                     = module.network.vpc_id
  private_subnet_ids         = module.network.private_subnet_ids
  app_security_group_id      = module.network.app_security_group_id
  internal_security_group_id = module.network.internal_security_group_id
  enable_efs                 = var.enable_efs
  efs_performance_mode       = var.efs_performance_mode
  efs_throughput_mode        = var.efs_throughput_mode
  efs_transition_to_ia       = var.efs_transition_to_ia
  efs_posix_uid              = var.efs_posix_uid
  efs_posix_gid              = var.efs_posix_gid
  efs_root_permissions       = var.efs_root_permissions
  efs_root_directory         = var.efs_root_directory
  enable_efs_backup          = var.enable_efs_backup
  efs_backup_retention_days  = var.efs_backup_retention_days
  efs_backup_schedule        = var.efs_backup_schedule
  tags                       = var.tags
}

module "alb" {
  source = "../modules/alb"

  project_id            = var.project_id
  project_name          = var.project_name
  environment_name      = var.environment_name
  vpc_id                = module.network.vpc_id
  public_subnet_ids     = module.network.public_subnet_ids
  alb_security_group_id = module.network.alb_security_group_id
  app_port              = var.app_port
  health_check_path     = var.alb_health_check_path
  enable_alb            = local.ecs_foundation_enabled
  tags                  = var.tags
}

module "database_service" {
  source = "../modules/database-service"

  project_id       = var.project_id
  environment_name = var.environment_name
  aws_region       = var.aws_region
  # A managed database is infrastructure-owned. It must be created with the
  # foundation, before the release lane creates an application service.
  enabled                  = var.database_service.enabled
  engine                   = var.database_service.engine
  image                    = var.database_service.image
  port                     = var.database_service.port
  task_cpu                 = var.database_service.cpu
  task_memory              = var.database_service.memory
  database_name            = var.database_service.database_name
  database_user            = var.database_service.database_user
  persistence_enabled      = var.database_service.persistence_enabled
  efs_enabled              = var.database_service.efs_enabled
  efs_mount_path           = var.database_service.efs_mount_path
  cloud_map_name           = var.database_service.cloud_map_name
  backup_enabled           = var.database_service.backup_enabled
  private_subnet_ids       = module.network.private_subnet_ids
  vpc_id                   = module.network.vpc_id
  app_security_group_id    = module.network.app_security_group_id
  cloud_map_namespace_id   = var.enable_cloud_map ? module.cloud_map[0].namespace_id : ""
  cloud_map_namespace_name = var.enable_cloud_map ? module.cloud_map[0].namespace_name : ""
  tags                     = var.tags
}

module "ecs_service" {
  source = "../modules/ecs-service"

  project_id                    = var.project_id
  project_name                  = var.project_name
  environment_name              = var.environment_name
  aws_region                    = var.aws_region
  enable_ecs_service            = var.enable_ecs_service
  enable_ecs_foundation         = var.enable_ecs_foundation
  enable_ecs_foundation_service = var.enable_ecs_foundation_service
  container_image               = var.ecs_container_image
  baseline_container_image      = var.ecs_baseline_container_image
  container_name                = var.ecs_container_name
  container_port                = var.app_port
  task_cpu                      = var.ecs_task_cpu
  task_memory                   = var.ecs_task_memory
  environment_variables         = var.ecs_environment_variables
  secret_environment_variables  = var.ecs_secret_environment_variables
  external_secret_environment_variables = var.database_service.enabled ? {
    for key, secret_type in var.database_secret_alias_types :
    key => secret_type == "url" ? module.database_service.database_url_secret_arn : module.database_service.password_secret_arn
  } : {}
  efs_enabled                   = module.efs.efs_enabled
  efs_file_system_id            = module.efs.efs_file_system_id
  efs_access_point_id           = module.efs.efs_access_point_id
  subnet_ids                    = local.ecs_subnet_ids
  assign_public_ip              = var.ecs_egress_strategy == "public_ip"
  app_security_group_id         = module.network.app_security_group_id
  target_group_arn              = module.alb.target_group_arn
  service_discovery_service_arn = var.enable_cloud_map ? module.cloud_map[0].default_service_arn : null
  use_fargate_spot              = var.ecs_use_fargate_spot
  enable_fargate_fallback       = var.ecs_enable_fargate_fallback
  desired_count                 = var.ecs_desired_count
  min_tasks                     = var.ecs_min_tasks
  max_tasks                     = var.ecs_max_tasks
  cpu_target_percent            = var.ecs_cpu_target_percent
  health_check_grace_seconds    = var.ecs_healthcheck_grace_seconds
  enable_container_insights     = var.ecs_container_insights
  enable_autoscaling            = var.ecs_enable_autoscaling
  tags                          = var.tags
  depends_on                    = [module.database_service]
}

module "eventbridge_spot" {
  source = "../modules/eventbridge-spot"

  project_id               = var.project_id
  environment_name         = var.environment_name
  enable_rule              = var.enable_ecs_service && var.enable_eventbridge_spot_rule
  ecs_cluster_arn          = module.ecs_service.ecs_cluster_arn
  api_destination_endpoint = var.spot_event_api_destination_endpoint
  api_destination_secret   = var.spot_event_api_destination_secret
  tags                     = var.tags
}
