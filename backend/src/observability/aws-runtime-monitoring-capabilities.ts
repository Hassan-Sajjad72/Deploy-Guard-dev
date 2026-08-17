/**
 * Read-only permissions required by the DeployGuard backend identity for
 * authoritative LIVE ECS log and CloudWatch telemetry collection. This is
 * intentionally separate from the GitHub Actions mutation-role contract.
 */
export const AWS_RUNTIME_MONITORING_CAPABILITY_VERSION = "deployguard.monitoring-aws/v1";

export const AWS_RUNTIME_MONITORING_ACTIONS = [
  "cloudwatch:GetMetricData",
  "ecs:DescribeServices",
  "ecs:DescribeTaskDefinition",
  "ecs:ListTasks",
  "elasticloadbalancing:DescribeTargetGroups",
  "elasticloadbalancing:DescribeTargetHealth",
  "logs:FilterLogEvents",
] as const;

export const AWS_RUNTIME_MONITORING_RESOURCE_SCOPE = "*";
