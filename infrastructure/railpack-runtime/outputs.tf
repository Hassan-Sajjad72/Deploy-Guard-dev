output "aws_region" { value = var.region }
output "ecs_cluster_arn" { value = aws_ecs_cluster.project.arn }
output "ecs_cluster_name" { value = aws_ecs_cluster.project.name }
output "services" {
  value = { for id, service in var.services : id => {
    name                       = service.name
    image                      = service.image
    ecs_service_arn            = aws_ecs_service.application[id].id
    ecs_service_name           = aws_ecs_service.application[id].name
    task_definition_arn        = aws_ecs_task_definition.application[id].arn
    alb_arn                    = aws_lb.application[id].arn
    alb_name                   = aws_lb.application[id].name
    alb_target_group_arn       = aws_lb_target_group.application[id].arn
    alb_target_group_name      = aws_lb_target_group.application[id].name
    public_url                 = "http://${aws_lb.application[id].dns_name}"
    cloudwatch_log_group_name  = aws_cloudwatch_log_group.application[id].name
    application_container_name = "application"
  } }
}
output "database_efs_file_system_id" { value = local.database_enabled ? aws_efs_file_system.database[0].id : null }
output "database_efs_access_point_id" { value = local.database_enabled ? aws_efs_access_point.database[0].id : null }
