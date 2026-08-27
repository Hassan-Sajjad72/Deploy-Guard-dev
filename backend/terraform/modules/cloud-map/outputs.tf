output "namespace_id" {
  value = aws_service_discovery_private_dns_namespace.this.id
}

output "namespace_name" {
  value = aws_service_discovery_private_dns_namespace.this.name
}

output "service_discovery_domain" {
  value = aws_service_discovery_private_dns_namespace.this.name
}

output "default_service_id" {
  value = aws_service_discovery_service.default.id
}

output "default_service_arn" {
  value = aws_service_discovery_service.default.arn
}
