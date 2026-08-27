output "deployguard_shared_ecs_cluster_arn" {
  value = aws_ecs_cluster.shared.arn
}

output "deployguard_shared_ecs_cluster_name" {
  value = aws_ecs_cluster.shared.name
}

output "deployguard_shared_alb_arn" {
  value = aws_lb.shared.arn
}

output "deployguard_shared_alb_dns_name" {
  value = aws_lb.shared.dns_name
}

output "deployguard_shared_alb_listener_arn" {
  value = aws_lb_listener.http.arn
}

output "deployguard_shared_alb_security_group_id" {
  value = aws_security_group.alb.id
}

output "deployguard_routing_domain" {
  value = var.routing_domain
}
