data "aws_vpc" "platform" {
  id = var.vpc_id
}

data "aws_subnet" "public" {
  for_each = toset(var.public_subnet_ids)
  id       = each.value
}

locals {
  ownership_tags = merge(var.tags, {
    ManagedBy        = "DeployGuard"
    DeployGuardScope = "shared-platform"
  })
}

resource "aws_ecs_cluster" "shared" {
  name = var.cluster_name

  setting {
    name  = "containerInsights"
    value = "enabled"
  }

  tags = local.ownership_tags
}

resource "aws_security_group" "alb" {
  name        = "${var.load_balancer_name}-alb"
  description = "HTTP ingress for the DeployGuard shared application load balancer"
  vpc_id      = data.aws_vpc.platform.id

  ingress {
    description = "Public HTTP"
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = local.ownership_tags
}

resource "aws_lb" "shared" {
  name               = var.load_balancer_name
  internal           = false
  load_balancer_type = "application"
  security_groups    = [aws_security_group.alb.id]
  subnets            = var.public_subnet_ids
  tags               = local.ownership_tags

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.shared.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type = "fixed-response"

    fixed_response {
      content_type = "application/json"
      message_body = "{\"status\":\"not_found\"}"
      status_code  = "404"
    }
  }

  tags = local.ownership_tags

  lifecycle {
    prevent_destroy = true
  }
}

check "public_subnets_match_vpc" {
  assert {
    condition     = alltrue([for subnet in data.aws_subnet.public : subnet.vpc_id == var.vpc_id && subnet.map_public_ip_on_launch])
    error_message = "Every configured shared-ALB subnet must be public and belong to the configured VPC."
  }
}
