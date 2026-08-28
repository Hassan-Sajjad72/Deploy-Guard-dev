output "image" { value = var.image }
output "ecs_service_arn" { value = aws_ecs_service.application.id }
output "task_definition_arn" { value = aws_ecs_task_definition.application.arn }
output "alb_url" { value = "http://${aws_lb.application.dns_name}" }
output "database_efs_access_point_id" { value = var.managed_postgres_enabled ? aws_efs_access_point.database[0].id : null }
