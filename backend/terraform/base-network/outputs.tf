output "vpc_id" {
  value = module.network.vpc_id
}

output "public_subnet_ids" {
  value = module.network.public_subnet_ids
}

output "private_subnet_ids" {
  value = module.network.private_subnet_ids
}

output "internet_gateway_id" {
  value = module.network.internet_gateway_id
}

output "nat_gateway_ids" {
  value = module.network.nat_gateway_ids
}

output "public_route_table_id" {
  value = module.network.public_route_table_id
}

output "private_route_table_id" {
  value = module.network.private_route_table_id
}

output "alb_security_group_id" {
  value = module.network.alb_security_group_id
}

output "app_security_group_id" {
  value = module.network.app_security_group_id
}

output "internal_security_group_id" {
  value = module.network.internal_security_group_id
}

output "cloud_map_namespace_id" {
  value = var.enable_cloud_map ? module.cloud_map[0].namespace_id : null
}

output "cloud_map_namespace_name" {
  value = var.enable_cloud_map ? module.cloud_map[0].namespace_name : null
}

output "cloud_map_service_discovery_domain" {
  value = var.enable_cloud_map ? module.cloud_map[0].service_discovery_domain : null
}

output "default_cloud_map_service_id" {
  value = var.enable_cloud_map ? module.cloud_map[0].default_service_id : null
}

output "ecr_repository_name" {
  value = module.registry.repository_name
}

output "ecr_repository_url" {
  value = module.registry.repository_url
}

output "canary_nat_gateway_count" {
  value = module.network.nat_gateway_count
}

output "canary_ecr_image_tag_mutability" {
  value = module.registry.image_tag_mutability
}

output "canary_ecs_assign_public_ip" {
  value = (var.enable_ecs_foundation || var.enable_ecs_foundation_service) && var.ecs_egress_strategy == "public_ip"
}

output "efs_enabled" {
  value = module.efs.efs_enabled
}

output "efs_file_system_id" {
  value = module.efs.efs_file_system_id
}

output "efs_file_system_arn" {
  value = module.efs.efs_file_system_arn
}

output "efs_kms_key_id" {
  value = module.efs.efs_kms_key_id
}

output "efs_kms_key_arn" {
  value = module.efs.efs_kms_key_arn
}

output "efs_access_point_id" {
  value = module.efs.efs_access_point_id
}

output "efs_access_point_arn" {
  value = module.efs.efs_access_point_arn
}

output "efs_security_group_id" {
  value = module.efs.efs_security_group_id
}

output "efs_mount_target_ids" {
  value = module.efs.efs_mount_target_ids
}

output "efs_dns_name" {
  value = module.efs.efs_dns_name
}

output "efs_root_directory" {
  value = module.efs.efs_root_directory
}

output "efs_posix_uid" {
  value = module.efs.efs_posix_uid
}

output "efs_posix_gid" {
  value = module.efs.efs_posix_gid
}

output "efs_root_permissions" {
  value = module.efs.efs_root_permissions
}

output "efs_backup_vault_name" {
  value = module.efs.efs_backup_vault_name
}

output "efs_backup_plan_id" {
  value = module.efs.efs_backup_plan_id
}

output "efs_backup_enabled" {
  value = module.efs.efs_backup_enabled
}

output "alb_arn" {
  value = module.alb.alb_arn
}

output "alb_dns_name" {
  value = module.alb.alb_dns_name
}

output "alb_target_group_arn" {
  value = module.alb.target_group_arn
}

output "alb_listener_arn" {
  value = module.alb.listener_arn
}

output "alb_health_check_path" {
  value = module.alb.health_check_path
}

output "ecs_cluster_arn" {
  value = module.ecs_service.ecs_cluster_arn
}

output "ecs_cluster_name" {
  value = module.ecs_service.ecs_cluster_name
}

output "ecs_service_arn" {
  value = module.ecs_service.ecs_service_arn
}

output "ecs_service_name" {
  value = module.ecs_service.ecs_service_name
}

output "ecs_task_definition_arn" {
  value = module.ecs_service.ecs_task_definition_arn
}

output "ecs_execution_role_arn" {
  value = module.ecs_service.ecs_execution_role_arn
}

output "ecs_task_role_arn" {
  value = module.ecs_service.ecs_task_role_arn
}

output "ecs_capacity_provider_strategy" {
  value = module.ecs_service.ecs_capacity_provider_strategy
}

output "ecs_desired_count" {
  value = module.ecs_service.ecs_desired_count
}

output "ecs_min_tasks" {
  value = module.ecs_service.ecs_min_tasks
}

output "ecs_max_tasks" {
  value = module.ecs_service.ecs_max_tasks
}

output "ecs_cpu_target_percent" {
  value = module.ecs_service.ecs_cpu_target_percent
}

output "ecs_container_name" {
  value = module.ecs_service.ecs_container_name
}

output "ecs_container_port" {
  value = module.ecs_service.ecs_container_port
}

output "ecs_log_group_name" {
  value = module.ecs_service.ecs_log_group_name
}

output "deployment_log_group_name" {
  value = module.ecs_service.deployment_log_group_name
}

output "spot_event_rule_name" {
  value = module.eventbridge_spot.spot_event_rule_name
}

output "spot_event_rule_arn" {
  value = module.eventbridge_spot.spot_event_rule_arn
}

output "spot_event_log_group_name" {
  value = module.eventbridge_spot.spot_event_log_group_name
}

output "database_enabled" { value = module.database_service.enabled }
output "database_internal_host" { value = module.database_service.internal_host }
output "database_port" { value = module.database_service.port }
output "database_service_arn" { value = module.database_service.service_arn }
output "database_cloud_map_service_arn" { value = module.database_service.cloud_map_service_arn }
output "database_cloud_map_service_id" { value = module.database_service.cloud_map_service_id }
output "database_task_definition_arn" { value = module.database_service.task_definition_arn }
output "database_security_group_id" { value = module.database_service.security_group_id }
output "database_efs_file_system_id" { value = module.database_service.efs_file_system_id }
output "database_efs_access_point_id" { value = module.database_service.efs_access_point_id }
output "database_password_secret_arn" { value = module.database_service.password_secret_arn }
output "database_url_secret_arn" { value = module.database_service.database_url_secret_arn }
output "database_backup_plan_id" { value = module.database_service.backup_plan_id }
