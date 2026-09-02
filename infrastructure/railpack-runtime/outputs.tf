output "aws_region" { value = var.region }
output "ecs_cluster_arn" { value = aws_ecs_cluster.project.arn }
output "ecs_cluster_name" { value = aws_ecs_cluster.project.name }
output "vpc_id" { value = var.vpc_id }
output "public_subnet_ids" { value = var.public_subnet_ids }
output "services" {
  value = { for id, service in var.services : id => {
    name                           = service.name
    image                          = service.image
    runtime_config_revision_id     = service.runtime_config_revision_id
    service_port                   = service.service_port
    ecs_service_arn                = aws_ecs_service.application[id].id
    ecs_service_name               = aws_ecs_service.application[id].name
    task_definition_arn            = aws_ecs_task_definition.application[id].arn
    alb_arn                        = aws_lb.application[id].arn
    alb_name                       = aws_lb.application[id].name
    alb_target_group_arn           = aws_lb_target_group.application[id].arn
    alb_target_group_name          = aws_lb_target_group.application[id].name
    public_url                     = "http://${aws_lb.application[id].dns_name}"
    cloudwatch_log_group_name      = aws_cloudwatch_log_group.application[id].name
    application_container_name     = "application"
    transport_probe_container_name = "deployguard-transport-probe"
    transport_probe_port           = local.transport_probe_ports[id]
    platform_health_check_path     = local.platform_health_check_path
    security_group_id              = aws_security_group.application[id].id
    alb_security_group_id          = aws_security_group.load_balancer[id].id
  } }
}
output "database_efs_file_system_id" { value = local.database_enabled ? aws_efs_file_system.database[0].id : null }
output "database_efs_access_point_id" { value = local.database_enabled ? aws_efs_access_point.database[0].id : null }
output "database" {
  value = local.database_enabled ? {
    attached_service_id       = local.database_service_id
    engine                    = local.database_engine
    host                      = local.database_host
    port                      = local.database_port
    ecs_service_arn           = aws_ecs_service.database[0].id
    ecs_service_name          = aws_ecs_service.database[0].name
    task_definition_arn       = aws_ecs_task_definition.database[0].arn
    cloudwatch_log_group_name = aws_cloudwatch_log_group.database[0].name
    efs_file_system_id        = aws_efs_file_system.database[0].id
    efs_access_point_id       = aws_efs_access_point.database[0].id
    credentials_secret_arn    = aws_secretsmanager_secret.database[0].arn
    secret_version_id         = aws_secretsmanager_secret_version.database[0].version_id
    security_group_id         = aws_security_group.database_runtime[0].id
    cloud_map_namespace_id    = aws_service_discovery_private_dns_namespace.database[0].id
    cloud_map_service_id      = aws_service_discovery_service.database[0].id
    cloud_map_service_arn     = aws_service_discovery_service.database[0].arn
  } : null
  sensitive = true
}
