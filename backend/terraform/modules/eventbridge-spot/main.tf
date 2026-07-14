locals {
  short_project_id = substr(replace(var.project_id, "-", ""), 0, 20)
  rule_name        = "dg-${local.short_project_id}-${var.environment_name}-ecs-events"
}

resource "aws_cloudwatch_log_group" "ecs_events" {
  count = var.enable_rule ? 1 : 0

  name              = "/deployguard/${var.project_id}/${var.environment_name}/ecs-events"
  retention_in_days = 14

  tags = var.tags
}

resource "aws_cloudwatch_log_resource_policy" "eventbridge" {
  count = var.enable_rule ? 1 : 0

  policy_name = "${local.rule_name}-logs"
  policy_document = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Principal = {
          Service = ["events.amazonaws.com", "delivery.logs.amazonaws.com"]
        }
        Action = [
          "logs:CreateLogStream",
          "logs:PutLogEvents"
        ]
        Resource = "${aws_cloudwatch_log_group.ecs_events[0].arn}:*"
      }
    ]
  })
}

resource "aws_cloudwatch_event_rule" "ecs_events" {
  count = var.enable_rule ? 1 : 0

  name        = local.rule_name
  description = "DeployGuard ECS task state change and interruption foundation"

  event_pattern = jsonencode({
    source      = ["aws.ecs"]
    detail-type = ["ECS Task State Change", "ECS Service Action"]
    detail = {
      clusterArn = var.ecs_cluster_arn == null ? [] : [var.ecs_cluster_arn]
    }
  })

  tags = var.tags
}

resource "aws_cloudwatch_event_target" "log_group" {
  count = var.enable_rule ? 1 : 0

  rule = aws_cloudwatch_event_rule.ecs_events[0].name
  arn  = aws_cloudwatch_log_group.ecs_events[0].arn

  depends_on = [aws_cloudwatch_log_resource_policy.eventbridge]
}

resource "aws_cloudwatch_event_connection" "deployguard" {
  count = var.enable_rule && var.api_destination_endpoint != "" && var.api_destination_secret != "" ? 1 : 0

  name               = "${local.rule_name}-connection"
  authorization_type = "API_KEY"

  auth_parameters {
    api_key {
      key   = "x-deployguard-spot-secret"
      value = var.api_destination_secret
    }
  }
}

resource "aws_cloudwatch_event_api_destination" "deployguard" {
  count = length(aws_cloudwatch_event_connection.deployguard)

  name                             = "${local.rule_name}-destination"
  invocation_endpoint              = var.api_destination_endpoint
  http_method                      = "POST"
  invocation_rate_limit_per_second = 5
  connection_arn                   = aws_cloudwatch_event_connection.deployguard[0].arn
}

data "aws_iam_policy_document" "eventbridge_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["events.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "api_destination" {
  count = length(aws_cloudwatch_event_api_destination.deployguard)

  name               = "${local.rule_name}-invoke"
  assume_role_policy = data.aws_iam_policy_document.eventbridge_assume.json
  tags               = var.tags
}

resource "aws_iam_role_policy" "api_destination" {
  count = length(aws_cloudwatch_event_api_destination.deployguard)

  name = "invoke-api-destination"
  role = aws_iam_role.api_destination[0].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = "events:InvokeApiDestination"
      Resource = aws_cloudwatch_event_api_destination.deployguard[0].arn
    }]
  })
}

resource "aws_cloudwatch_event_target" "deployguard" {
  count = length(aws_cloudwatch_event_api_destination.deployguard)

  rule     = aws_cloudwatch_event_rule.ecs_events[0].name
  arn      = aws_cloudwatch_event_api_destination.deployguard[0].arn
  role_arn = aws_iam_role.api_destination[0].arn
}
