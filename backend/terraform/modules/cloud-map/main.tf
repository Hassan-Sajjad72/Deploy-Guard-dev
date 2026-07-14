resource "aws_service_discovery_private_dns_namespace" "this" {
  name        = var.namespace_name
  description = "DeployGuard private service discovery namespace"
  vpc         = var.vpc_id

  tags = merge(var.tags, {
    Name                 = var.namespace_name
    ManagedBy            = "DeployGuard"
    DeployGuardProjectId = var.project_id
    Environment          = var.environment_name
  })
}

resource "aws_service_discovery_service" "default" {
  name = var.default_service_name

  dns_config {
    namespace_id = aws_service_discovery_private_dns_namespace.this.id

    dns_records {
      ttl  = 10
      type = "A"
    }

    routing_policy = "MULTIVALUE"
  }

  health_check_custom_config {
    failure_threshold = 1
  }

  tags = merge(var.tags, {
    Name                 = "${var.default_service_name}.${var.namespace_name}"
    ManagedBy            = "DeployGuard"
    DeployGuardProjectId = var.project_id
    Environment          = var.environment_name
  })
}
