mock_provider "aws" {
  mock_data "aws_availability_zones" {
    defaults = {
      names = ["us-east-1a", "us-east-1b"]
    }
  }
}

run "canary_foundation_no_nat" {
  command = plan

  variables {
    project_id                   = "11111111-1111-4111-8111-111111111111"
    project_name                 = "canary-plan"
    environment_name             = "dev"
    aws_region                   = "us-east-1"
    offline_plan_mode            = true
    availability_zone_names      = ["us-east-1a", "us-east-1b"]
    vpc_cidr                     = "10.254.0.0/16"
    public_subnet_cidrs          = ["10.254.1.0/24", "10.254.2.0/24"]
    private_subnet_cidrs         = ["10.254.101.0/24", "10.254.102.0/24"]
    nat_mode                     = "none"
    cloud_map_namespace          = "canary.deployguard.local"
    enable_cloud_map             = false
    app_port                     = 8080
    manage_ecr_repository        = true
    ecr_repository_name          = "deployguard-canary-plan"
    enable_ecs_foundation        = true
    ecs_egress_strategy          = "public_ip"
    ecs_desired_count            = 0
    ecs_min_tasks                = 0
    ecs_max_tasks                = 0
    ecs_enable_autoscaling       = false
    enable_eventbridge_spot_rule = false
    tags = {
      "deployguard:project-id"                 = "11111111-1111-4111-8111-111111111111"
      "deployguard:environment"                = "dev"
      "deployguard:infrastructure-manifest-id" = "22222222-2222-4222-8222-222222222222"
      "deployguard:infrastructure-revision"    = "1"
      "deployguard:infrastructure-input-hash"  = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    }
  }

  assert {
    condition     = output.canary_nat_gateway_count == 0
    error_message = "natMode=none must not plan a NAT gateway."
  }

  assert {
    condition     = output.canary_ecr_image_tag_mutability == "IMMUTABLE"
    error_message = "The canary ECR repository must use immutable image tags."
  }

  assert {
    condition     = output.canary_ecs_assign_public_ip
    error_message = "The no-NAT foundation must use public-IP ECS egress."
  }

  assert {
    condition     = output.ecs_task_definition_arn == null && output.ecs_service_arn == null
    error_message = "The foundation must not create an application task definition or ECS service."
  }
}
