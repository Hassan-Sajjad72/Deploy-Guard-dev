terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.0"
    }
  }

  backend "s3" {}
}

provider "aws" {
  region = var.region
}

locals {
  name = "dg-${substr(replace(var.project_id, "-", ""), 0, 12)}"
  tags = {
    ManagedBy              = "DeployGuard"
    DeployGuardProjectId   = var.project_id
    DeployGuardOperationId = var.operation_id
  }
}

resource "aws_cloudwatch_log_group" "application" {
  name              = "/deployguard/${var.project_id}/application"
  retention_in_days = 14
  tags              = local.tags
}

resource "aws_ecs_cluster" "application" {
  name = local.name
  tags = local.tags
}

resource "aws_security_group" "load_balancer" {
  name_prefix = "${local.name}-alb-"
  vpc_id      = var.vpc_id

  ingress {
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

  tags = local.tags
}

resource "aws_security_group" "application" {
  name_prefix = "${local.name}-app-"
  vpc_id      = var.vpc_id

  ingress {
    from_port       = var.platform_port
    to_port         = var.platform_port
    protocol        = "tcp"
    security_groups = [aws_security_group.load_balancer.id]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = local.tags
}

resource "aws_security_group" "postgres" {
  count       = var.managed_postgres_enabled ? 1 : 0
  name_prefix = "${local.name}-postgres-"
  vpc_id      = var.vpc_id

  ingress {
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [aws_security_group.application.id]
  }

  tags = local.tags
}

resource "aws_db_subnet_group" "postgres" {
  count      = var.managed_postgres_enabled ? 1 : 0
  name       = "${local.name}-postgres"
  subnet_ids = var.public_subnet_ids
  tags       = local.tags
}

resource "random_password" "postgres" {
  count   = var.managed_postgres_enabled ? 1 : 0
  length  = 32
  special = false
}

resource "aws_db_instance" "postgres" {
  count                  = var.managed_postgres_enabled ? 1 : 0
  identifier             = "${local.name}-postgres"
  allocated_storage      = 20
  engine                 = "postgres"
  engine_version         = "16"
  instance_class         = "db.t4g.micro"
  db_name                = "application"
  username               = "deployguard"
  password               = random_password.postgres[0].result
  db_subnet_group_name   = aws_db_subnet_group.postgres[0].name
  vpc_security_group_ids = [aws_security_group.postgres[0].id]
  skip_final_snapshot    = true
  publicly_accessible    = false
  tags                   = local.tags
}

resource "aws_secretsmanager_secret" "postgres" {
  count = var.managed_postgres_enabled ? 1 : 0
  name  = "deployguard/${var.project_id}/postgres"
  tags  = local.tags
}

resource "aws_secretsmanager_secret_version" "postgres" {
  count     = var.managed_postgres_enabled ? 1 : 0
  secret_id = aws_secretsmanager_secret.postgres[0].id
  secret_string = jsonencode({
    password = random_password.postgres[0].result
    url      = "postgresql://deployguard:${random_password.postgres[0].result}@${aws_db_instance.postgres[0].address}:5432/application"
  })
}

resource "aws_lb" "application" {
  name               = local.name
  internal           = false
  load_balancer_type = "application"
  security_groups    = [aws_security_group.load_balancer.id]
  subnets            = var.public_subnet_ids
  tags               = local.tags
}

resource "aws_lb_target_group" "application" {
  name        = local.name
  port        = var.platform_port
  protocol    = "HTTP"
  target_type = "ip"
  vpc_id      = var.vpc_id

  health_check {
    path    = "/"
    matcher = "200-399"
  }

  tags = local.tags
}

resource "aws_lb_listener" "application" {
  load_balancer_arn = aws_lb.application.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.application.arn
  }
}

data "aws_iam_policy_document" "ecs_task_assume_role" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "execution" {
  name               = "${local.name}-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_task_assume_role.json
  tags               = local.tags
}

resource "aws_iam_role_policy_attachment" "execution" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

data "aws_iam_policy_document" "runtime_secrets" {
  statement {
    actions = ["secretsmanager:GetSecretValue"]
    resources = distinct(concat(
      [for reference in values(var.secret_references) : split(":", reference)[0] == "arn" ? join(":", slice(split(":", reference), 0, 7)) : reference],
      var.managed_postgres_enabled ? [aws_secretsmanager_secret.postgres[0].arn] : [],
    ))
  }
}

resource "aws_iam_role_policy" "runtime_secrets" {
  name   = "runtime-secrets"
  role   = aws_iam_role.execution.id
  policy = data.aws_iam_policy_document.runtime_secrets.json
}

locals {
  postgres_environment = var.managed_postgres_enabled ? merge(
    { for key in var.managed_postgres_aliases : key => aws_db_instance.postgres[0].address if contains(["DB_HOST", "DATABASE_HOST", "POSTGRES_HOST", "PGHOST"], key) },
    { for key in var.managed_postgres_aliases : key => "5432" if contains(["DB_PORT", "DATABASE_PORT", "POSTGRES_PORT", "PGPORT"], key) },
    { for key in var.managed_postgres_aliases : key => "deployguard" if contains(["DB_USER", "DATABASE_USER", "POSTGRES_USER", "PGUSER"], key) },
    { for key in var.managed_postgres_aliases : key => "application" if contains(["DB_NAME", "DATABASE_NAME", "POSTGRES_DB", "PGDATABASE"], key) },
  ) : {}
  postgres_secrets = var.managed_postgres_enabled ? {
    for key in var.managed_postgres_aliases : key => "${aws_secretsmanager_secret.postgres[0].arn}:${contains(["DATABASE_URL", "POSTGRES_URL", "POSTGRESQL_URL"], key) ? "url" : "password"}::"
    if contains(["DB_PASSWORD", "DATABASE_PASSWORD", "POSTGRES_PASSWORD", "PGPASSWORD", "DATABASE_URL", "POSTGRES_URL", "POSTGRESQL_URL"], key)
  } : {}
}

resource "aws_ecs_task_definition" "application" {
  family                   = local.name
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = "512"
  memory                   = "1024"
  execution_role_arn       = aws_iam_role.execution.arn

  container_definitions = jsonencode([{
    name      = "application"
    image     = var.image
    essential = true
    portMappings = [{
      containerPort = var.platform_port
      hostPort      = var.platform_port
      protocol      = "tcp"
    }]
    environment = [for key, value in merge(var.environment, local.postgres_environment) : { name = key, value = value }]
    secrets     = [for key, value in merge(var.secret_references, local.postgres_secrets) : { name = key, valueFrom = value }]
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.application.name
        awslogs-region        = var.region
        awslogs-stream-prefix = "application"
      }
    }
  }])

  tags = local.tags
}

resource "aws_ecs_service" "application" {
  name            = local.name
  cluster         = aws_ecs_cluster.application.id
  task_definition = aws_ecs_task_definition.application.arn
  desired_count   = 1
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = var.public_subnet_ids
    security_groups  = [aws_security_group.application.id]
    assign_public_ip = true
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.application.arn
    container_name   = "application"
    container_port   = var.platform_port
  }

  depends_on = [aws_lb_listener.application, aws_iam_role_policy.runtime_secrets]
  tags       = local.tags
}
