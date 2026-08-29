output "ecs_cluster_arn" {
  value = local.enable_foundation ? aws_ecs_cluster.this[0].arn : null
}

output "ecs_cluster_name" {
  value = local.enable_foundation ? aws_ecs_cluster.this[0].name : null
}

output "ecs_service_arn" {
  value = local.enable_service ? aws_ecs_service.app[0].id : null
}

output "ecs_service_name" {
  value = local.enable_service ? aws_ecs_service.app[0].name : null
}

output "ecs_task_definition_arn" {
  value = local.enable_service ? aws_ecs_task_definition.app[0].arn : null
}

output "ecs_capacity_provider_strategy" {
  value = local.capacity_provider_strategy
}

output "ecs_desired_count" {
  value = var.desired_count
}

output "ecs_min_tasks" {
  value = var.min_tasks
}

output "ecs_max_tasks" {
  value = var.max_tasks
}

output "ecs_cpu_target_percent" {
  value = var.cpu_target_percent
}

output "ecs_container_name" {
  value = var.container_name
}

output "ecs_container_port" {
  value = var.container_port
}

output "ecs_log_group_name" {
  value = local.enable_foundation ? aws_cloudwatch_log_group.app[0].name : null
}

output "deployment_log_group_name" {
  value = local.enable_foundation ? aws_cloudwatch_log_group.deployment[0].name : null
}

output "ecs_execution_role_arn" {
  value = local.enable_foundation ? aws_iam_role.execution[0].arn : null
}

output "ecs_task_role_arn" {
  value = local.enable_foundation ? aws_iam_role.task[0].arn : null
}
