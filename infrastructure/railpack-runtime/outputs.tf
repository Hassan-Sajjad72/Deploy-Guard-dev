output "image" { value = var.image }
output "ecs_service_arn" { value = aws_ecs_service.application.id }
output "task_definition_arn" { value = aws_ecs_task_definition.application.arn }
output "alb_url" { value = "http://${aws_lb.application.dns_name}" }
