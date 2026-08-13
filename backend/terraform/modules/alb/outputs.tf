output "alb_arn" {
  value = var.enable_alb ? aws_lb.this[0].arn : null
}

output "alb_dns_name" {
  value = var.enable_alb ? aws_lb.this[0].dns_name : null
}

output "target_group_arn" {
  value = var.enable_alb ? aws_lb_target_group.app[0].arn : null
}

output "listener_arn" {
  value = var.enable_alb ? aws_lb_listener.http[0].arn : null
}

output "health_check_path" {
  value = var.health_check_path
}
