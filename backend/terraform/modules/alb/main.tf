locals {
  short_project_id = substr(replace(var.project_id, "-", ""), 0, 20)
  name_prefix      = "dg-${local.short_project_id}-${var.environment_name}"
}

resource "aws_lb" "this" {
  count = var.enable_alb ? 1 : 0

  name               = "${local.name_prefix}-alb"
  internal           = false
  load_balancer_type = "application"
  security_groups    = [var.alb_security_group_id]
  subnets            = var.public_subnet_ids

  tags = merge(var.tags, {
    Name                 = "${local.name_prefix}-alb"
    ManagedBy            = "DeployGuard"
    DeployGuardProjectId = var.project_id
    Environment          = var.environment_name
  })
}

resource "aws_lb_target_group" "app" {
  count = var.enable_alb ? 1 : 0

  name        = "${local.name_prefix}-tg"
  port        = var.app_port
  protocol    = "HTTP"
  target_type = "ip"
  vpc_id      = var.vpc_id

  health_check {
    enabled             = true
    path                = var.health_check_path
    protocol            = "HTTP"
    matcher             = "200-399"
    interval            = 30
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }

  tags = merge(var.tags, {
    Name                 = "${local.name_prefix}-tg"
    ManagedBy            = "DeployGuard"
    DeployGuardProjectId = var.project_id
    Environment          = var.environment_name
  })
}

resource "aws_lb_listener" "http" {
  count = var.enable_alb ? 1 : 0

  load_balancer_arn = aws_lb.this[0].arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.app[0].arn
  }
}
