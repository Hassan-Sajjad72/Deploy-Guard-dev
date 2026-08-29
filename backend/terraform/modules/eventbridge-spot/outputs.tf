output "spot_event_rule_name" {
  value = var.enable_rule ? aws_cloudwatch_event_rule.ecs_events[0].name : null
}

output "spot_event_rule_arn" {
  value = var.enable_rule ? aws_cloudwatch_event_rule.ecs_events[0].arn : null
}

output "spot_event_log_group_name" {
  value = var.enable_rule ? aws_cloudwatch_log_group.ecs_events[0].name : null
}
