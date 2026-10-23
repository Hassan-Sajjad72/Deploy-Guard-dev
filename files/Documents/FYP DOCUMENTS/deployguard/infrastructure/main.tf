terraform {
  required_version = ">= 1.5.0"
  required_providers { aws = { source = "hashicorp/aws"; version = "~> 5.0" } }
}

provider "aws" {
  region = var.aws_region
  default_tags { tags = { Project="DeployGuard"; Environment=var.environment; ManagedBy="Terraform" } }
}

data "aws_availability_zones" "available" { state = "available" }

# VPC
resource "aws_vpc" "main" {
  cidr_block = var.vpc_cidr; enable_dns_hostnames = true; enable_dns_support = true
  tags = { Name = "${var.project_name}-vpc" }
}
resource "aws_internet_gateway" "main" { vpc_id = aws_vpc.main.id; tags = { Name = "${var.project_name}-igw" } }

resource "aws_subnet" "public" {
  count = var.az_count; vpc_id = aws_vpc.main.id
  cidr_block = cidrsubnet(var.vpc_cidr, 8, count.index)
  availability_zone = data.aws_availability_zones.available.names[count.index]
  map_public_ip_on_launch = true
  tags = { Name = "${var.project_name}-public-${count.index+1}" }
}
resource "aws_subnet" "private" {
  count = var.az_count; vpc_id = aws_vpc.main.id
  cidr_block = cidrsubnet(var.vpc_cidr, 8, count.index + var.az_count)
  availability_zone = data.aws_availability_zones.available.names[count.index]
  tags = { Name = "${var.project_name}-private-${count.index+1}" }
}

resource "aws_eip" "nat"         { count = var.az_count; domain = "vpc"; tags = { Name = "${var.project_name}-eip-${count.index+1}" } }
resource "aws_nat_gateway" "main" {
  count = var.az_count; allocation_id = aws_eip.nat[count.index].id; subnet_id = aws_subnet.public[count.index].id
  tags = { Name = "${var.project_name}-nat-${count.index+1}" }; depends_on = [aws_internet_gateway.main]
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id
  route { cidr_block = "0.0.0.0/0"; gateway_id = aws_internet_gateway.main.id }
  tags = { Name = "${var.project_name}-public-rt" }
}
resource "aws_route_table_association" "public"  { count = var.az_count; subnet_id = aws_subnet.public[count.index].id; route_table_id = aws_route_table.public.id }

resource "aws_route_table" "private" {
  count = var.az_count; vpc_id = aws_vpc.main.id
  route { cidr_block = "0.0.0.0/0"; nat_gateway_id = aws_nat_gateway.main[count.index].id }
  tags = { Name = "${var.project_name}-private-rt-${count.index+1}" }
}
resource "aws_route_table_association" "private" { count = var.az_count; subnet_id = aws_subnet.private[count.index].id; route_table_id = aws_route_table.private[count.index].id }

# Security Groups
resource "aws_security_group" "alb" {
  name = "${var.project_name}-alb-sg"; description = "ALB"; vpc_id = aws_vpc.main.id
  ingress { from_port=80;  to_port=80;  protocol="tcp"; cidr_blocks=["0.0.0.0/0"] }
  ingress { from_port=443; to_port=443; protocol="tcp"; cidr_blocks=["0.0.0.0/0"] }
  egress  { from_port=0;   to_port=0;   protocol="-1";  cidr_blocks=["0.0.0.0/0"] }
  tags = { Name = "${var.project_name}-alb-sg" }
}
resource "aws_security_group" "ecs" {
  name = "${var.project_name}-ecs-sg"; description = "ECS Tasks"; vpc_id = aws_vpc.main.id
  ingress { from_port=0; to_port=65535; protocol="tcp"; security_groups=[aws_security_group.alb.id] }
  egress  { from_port=0; to_port=0;     protocol="-1";  cidr_blocks=["0.0.0.0/0"] }
  tags = { Name = "${var.project_name}-ecs-sg" }
}
resource "aws_security_group" "efs" {
  name = "${var.project_name}-efs-sg"; description = "EFS"; vpc_id = aws_vpc.main.id
  ingress { from_port=2049; to_port=2049; protocol="tcp"; security_groups=[aws_security_group.ecs.id] }
  egress  { from_port=0;    to_port=0;    protocol="-1";  cidr_blocks=["0.0.0.0/0"] }
  tags = { Name = "${var.project_name}-efs-sg" }
}

# ECR
resource "aws_ecr_repository" "app" {
  name = "${var.project_name}-app"; image_tag_mutability = "MUTABLE"
  image_scanning_configuration { scan_on_push = true }
}
resource "aws_ecr_lifecycle_policy" "app" {
  repository = aws_ecr_repository.app.name
  policy = jsonencode({ rules = [{ rulePriority=1; description="Keep 10"; selection={tagStatus="any";countType="imageCountMoreThan";countNumber=10}; action={type="expire"} }] })
}

# CloudWatch
resource "aws_cloudwatch_log_group" "ecs" { name = "/ecs/${var.project_name}"; retention_in_days = 30 }

# IAM
resource "aws_iam_role" "ecs_exec" {
  name = "${var.project_name}-ecs-exec-role"
  assume_role_policy = jsonencode({ Version="2012-10-17"; Statement=[{ Effect="Allow"; Principal={Service="ecs-tasks.amazonaws.com"}; Action="sts:AssumeRole" }] })
}
resource "aws_iam_role_policy_attachment" "ecs_exec" { role = aws_iam_role.ecs_exec.name; policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy" }

resource "aws_iam_role" "ecs_task" {
  name = "${var.project_name}-ecs-task-role"
  assume_role_policy = jsonencode({ Version="2012-10-17"; Statement=[{ Effect="Allow"; Principal={Service="ecs-tasks.amazonaws.com"}; Action="sts:AssumeRole" }] })
}
resource "aws_iam_role_policy" "ecs_task" {
  name = "${var.project_name}-task-policy"; role = aws_iam_role.ecs_task.id
  policy = jsonencode({ Version="2012-10-17"; Statement=[
    { Effect="Allow"; Action=["ssm:GetParameter*"]; Resource="arn:aws:ssm:${var.aws_region}:*:parameter/${var.project_name}/*" },
    { Effect="Allow"; Action=["secretsmanager:GetSecretValue"]; Resource="arn:aws:secretsmanager:${var.aws_region}:*:secret:${var.project_name}/*" }
  ]})
}

# ALB
resource "aws_lb" "main" {
  name = "${var.project_name}-alb"; internal = false; load_balancer_type = "application"
  security_groups = [aws_security_group.alb.id]; subnets = aws_subnet.public[*].id
  tags = { Name = "${var.project_name}-alb" }
}
resource "aws_lb_target_group" "backend" {
  name = "${var.project_name}-be-tg"; port = var.backend_port; protocol = "HTTP"
  vpc_id = aws_vpc.main.id; target_type = "ip"
  health_check { path="/api/v1/health"; healthy_threshold=2; unhealthy_threshold=3; timeout=5; interval=30; matcher="200" }
}
resource "aws_lb_target_group" "frontend" {
  name = "${var.project_name}-fe-tg"; port = var.frontend_port; protocol = "HTTP"
  vpc_id = aws_vpc.main.id; target_type = "ip"
  health_check { path="/"; healthy_threshold=2; unhealthy_threshold=3; timeout=5; interval=30; matcher="200" }
}
resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.main.arn; port = 80; protocol = "HTTP"
  default_action { type = "forward"; target_group_arn = aws_lb_target_group.frontend.arn }
}
resource "aws_lb_listener_rule" "api" {
  listener_arn = aws_lb_listener.http.arn; priority = 100
  action { type = "forward"; target_group_arn = aws_lb_target_group.backend.arn }
  condition { path_pattern { values = ["/api/*"] } }
}

# ECS Cluster (Fargate Spot)
resource "aws_ecs_cluster" "main" {
  name = "${var.project_name}-cluster"
  configuration { execute_command_configuration { logging="OVERRIDE"; log_configuration { cloud_watch_log_group_name = aws_cloudwatch_log_group.ecs.name } } }
}
resource "aws_ecs_cluster_capacity_providers" "main" {
  cluster_name = aws_ecs_cluster.main.name; capacity_providers = ["FARGATE","FARGATE_SPOT"]
  default_capacity_provider_strategy { capacity_provider="FARGATE_SPOT"; weight=80; base=0 }
  default_capacity_provider_strategy { capacity_provider="FARGATE";      weight=20; base=1 }
}

# Task Definitions
resource "aws_ecs_task_definition" "backend" {
  family = "${var.project_name}-backend"; network_mode = "awsvpc"
  requires_compatibilities = ["FARGATE"]; cpu = var.task_cpu; memory = var.task_memory
  execution_role_arn = aws_iam_role.ecs_exec.arn; task_role_arn = aws_iam_role.ecs_task.arn
  container_definitions = jsonencode([{
    name="backend"; image="${aws_ecr_repository.app.repository_url}:latest"; essential=true
    portMappings=[{containerPort=var.backend_port;protocol="tcp"}]
    environment=[{name="NODE_ENV";value=var.environment},{name="PORT";value=tostring(var.backend_port)}]
    logConfiguration={ logDriver="awslogs"; options={"awslogs-group"=aws_cloudwatch_log_group.ecs.name;"awslogs-region"=var.aws_region;"awslogs-stream-prefix"="backend"} }
  }])
}
resource "aws_ecs_task_definition" "frontend" {
  family = "${var.project_name}-frontend"; network_mode = "awsvpc"
  requires_compatibilities = ["FARGATE"]; cpu = var.task_cpu; memory = var.task_memory
  execution_role_arn = aws_iam_role.ecs_exec.arn; task_role_arn = aws_iam_role.ecs_task.arn
  container_definitions = jsonencode([{
    name="frontend"; image="${aws_ecr_repository.app.repository_url}:frontend-latest"; essential=true
    portMappings=[{containerPort=var.frontend_port;protocol="tcp"}]
    environment=[{name="NEXT_PUBLIC_API_URL";value="http://${aws_lb.main.dns_name}/api/v1"}]
    logConfiguration={ logDriver="awslogs"; options={"awslogs-group"=aws_cloudwatch_log_group.ecs.name;"awslogs-region"=var.aws_region;"awslogs-stream-prefix"="frontend"} }
  }])
}

# ECS Services
resource "aws_ecs_service" "backend" {
  name = "${var.project_name}-backend"; cluster = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.backend.arn; desired_count = var.service_desired_count
  capacity_provider_strategy { capacity_provider="FARGATE_SPOT"; weight=80; base=0 }
  capacity_provider_strategy { capacity_provider="FARGATE";      weight=20; base=1 }
  network_configuration { subnets=aws_subnet.private[*].id; security_groups=[aws_security_group.ecs.id] }
  load_balancer { target_group_arn=aws_lb_target_group.backend.arn; container_name="backend"; container_port=var.backend_port }
  deployment_minimum_healthy_percent=50; deployment_maximum_percent=200
  deployment_circuit_breaker { enable=true; rollback=true }
  lifecycle { ignore_changes=[desired_count,task_definition] }
  depends_on=[aws_lb_listener.http]
  tags = { Name = "${var.project_name}-backend-svc" }
}
resource "aws_ecs_service" "frontend" {
  name = "${var.project_name}-frontend"; cluster = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.frontend.arn; desired_count = var.service_desired_count
  capacity_provider_strategy { capacity_provider="FARGATE_SPOT"; weight=80; base=0 }
  capacity_provider_strategy { capacity_provider="FARGATE";      weight=20; base=1 }
  network_configuration { subnets=aws_subnet.private[*].id; security_groups=[aws_security_group.ecs.id] }
  load_balancer { target_group_arn=aws_lb_target_group.frontend.arn; container_name="frontend"; container_port=var.frontend_port }
  deployment_circuit_breaker { enable=true; rollback=true }
  lifecycle { ignore_changes=[desired_count,task_definition] }
  depends_on=[aws_lb_listener.http]
  tags = { Name = "${var.project_name}-frontend-svc" }
}

# Auto-Scaling
resource "aws_appautoscaling_target" "backend" {
  max_capacity=var.max_capacity; min_capacity=var.min_capacity
  resource_id="service/${aws_ecs_cluster.main.name}/${aws_ecs_service.backend.name}"
  scalable_dimension="ecs:service:DesiredCount"; service_namespace="ecs"
}
resource "aws_appautoscaling_policy" "backend_cpu" {
  name="${var.project_name}-cpu-scaling"; policy_type="TargetTrackingScaling"
  resource_id=aws_appautoscaling_target.backend.resource_id
  scalable_dimension=aws_appautoscaling_target.backend.scalable_dimension
  service_namespace=aws_appautoscaling_target.backend.service_namespace
  target_tracking_scaling_policy_configuration {
    target_value=70.0; scale_in_cooldown=300; scale_out_cooldown=60
    predefined_metric_specification { predefined_metric_type="ECSServiceAverageCPUUtilization" }
  }
}
resource "aws_appautoscaling_policy" "backend_mem" {
  name="${var.project_name}-mem-scaling"; policy_type="TargetTrackingScaling"
  resource_id=aws_appautoscaling_target.backend.resource_id
  scalable_dimension=aws_appautoscaling_target.backend.scalable_dimension
  service_namespace=aws_appautoscaling_target.backend.service_namespace
  target_tracking_scaling_policy_configuration {
    target_value=80.0; scale_in_cooldown=300; scale_out_cooldown=60
    predefined_metric_specification { predefined_metric_type="ECSServiceAverageMemoryUtilization" }
  }
}

# EFS
resource "aws_efs_file_system" "main" {
  creation_token="${var.project_name}-efs"; encrypted=true
  lifecycle_policy { transition_to_ia="AFTER_30_DAYS" }
  tags = { Name = "${var.project_name}-efs" }
}
resource "aws_efs_mount_target" "main" {
  count=var.az_count; file_system_id=aws_efs_file_system.main.id
  subnet_id=aws_subnet.private[count.index].id; security_groups=[aws_security_group.efs.id]
}

# SNS
resource "aws_sns_topic" "notifications" { name = "${var.project_name}-notifications" }
resource "aws_sns_topic_subscription" "email" {
  count=var.notification_email != "" ? 1 : 0
  topic_arn=aws_sns_topic.notifications.arn; protocol="email"; endpoint=var.notification_email
}
