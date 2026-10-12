import { SimulatePrincipalPolicyCommand } from "@aws-sdk/client-iam";
import { capabilitiesFor, WorkflowAwsCapabilityScope, WorkflowLifecycleAction } from "./github-actions-aws-capability-contract";

export function customerTaskRoleBoundary(scope: WorkflowAwsCapabilityScope) {
  const arn = (service: string, suffix: string) => `arn:aws:${service}:${scope.region}:${scope.accountId}:${suffix}`;
  return { Version: "2012-10-17", Statement: [
    { Effect: "Allow", Action: ["ecr:GetAuthorizationToken"], Resource: "*", Condition: { StringEquals: { "aws:RequestedRegion": scope.region } } },
    { Effect: "Allow", Action: ["ecr:BatchCheckLayerAvailability", "ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer"], Resource: arn("ecr", `repository/deployguard-${scope.projectId.replaceAll("-", "").slice(0, 12)}-*`) },
    { Effect: "Allow", Action: ["logs:CreateLogStream", "logs:PutLogEvents"], Resource: arn("logs", `log-group:/deployguard/${scope.projectId}/*:*`) },
    { Effect: "Allow", Action: ["secretsmanager:GetSecretValue"], Resource: arn("secretsmanager", `secret:deployguard/${scope.projectId}/${scope.environmentName}/*`) },
  ] };
}

/** Concrete simulation targets and ownership contexts for the customer adapter.
 * Simulations are admission evidence; they never certify a live provider. */
export function customerCapabilityResources(scope: WorkflowAwsCapabilityScope, action: string): string[] | null {
  const name = `dg-${scope.projectId.replaceAll("-", "").slice(0, 12)}`, prefix = `arn:aws`;
  const regional = (service: string, suffix: string) => `${prefix}:${service}:${scope.region}:${scope.accountId}:${suffix}`;
  if (action.startsWith("ecs:")) {
    if (action === "ecs:RegisterTaskDefinition") return ["*"];
    if (/Cluster/.test(action)) return [regional("ecs", `cluster/${name}`)];
    if (/TaskDefinition/.test(action)) return [regional("ecs", `task-definition/${name}-simulation:1`)];
    if (/Service/.test(action)) return [regional("ecs", `service/${name}/${name}-simulation`)];
  }
  if (action.startsWith("iam:") && action !== "iam:CreateServiceLinkedRole") return [`arn:aws:iam::${scope.accountId}:role/${name}-execution`];
  if (action.startsWith("ecr:") && action !== "ecr:GetAuthorizationToken") return [regional("ecr", `repository/deployguard-${scope.projectId.replaceAll("-", "").slice(0, 12)}-simulation`)];
  if (action.startsWith("logs:") && action !== "logs:DescribeLogGroups") return [regional("logs", `log-group:/deployguard/${scope.projectId}/services/simulation:*`)];
  if (action.startsWith("secretsmanager:") && action !== "secretsmanager:CreateSecret") return [regional("secretsmanager", `secret:deployguard/${scope.projectId}/${scope.environmentName}/services/simulation/runtime-abcdef`)];
  return null;
}

export function customerCapabilitiesFor(scope: WorkflowAwsCapabilityScope, action: WorkflowLifecycleAction, executionBoundaryArn?: string) {
  return capabilitiesFor(action, scope).map((capability) => ({ ...capability,
    simulationResources: (actual: WorkflowAwsCapabilityScope, operation: string) => customerCapabilityResources(actual, operation) || capability.simulationResources?.(actual, operation) || capability.resources(actual),
    simulationContextForAction: (actual: WorkflowAwsCapabilityScope, operation: string) => ({
      ...(capability.simulationContextForAction?.(actual, operation) || capability.simulationContext?.(actual) || {}),
      "aws:RequestedRegion": [actual.region], "aws:ResourceAccount": [actual.accountId],
      "aws:RequestTag/DeployGuardProjectId": [actual.projectId], "aws:ResourceTag/DeployGuardProjectId": [actual.projectId],
      "aws:RequestTag/ManagedBy": ["DeployGuard"], "aws:ResourceTag/ManagedBy": ["DeployGuard"],
      "ecs:cluster": [`arn:aws:ecs:${actual.region}:${actual.accountId}:cluster/dg-${actual.projectId.replaceAll("-", "").slice(0, 12)}`],
      ...(executionBoundaryArn ? { "iam:PermissionsBoundary": [executionBoundaryArn] } : {}),
    }),
  }));
}

export async function verifyCustomerWorkflowIsolation(client: { send(command: unknown, options?: any): Promise<any> }, roleArn: string, scope: WorkflowAwsCapabilityScope, signal?: AbortSignal) {
  const foreign = "ffffffff-ffff-4fff-8fff-ffffffffffff", foreignName = "dg-ffffffffffff";
  const regional = (service: string, suffix: string) => `arn:aws:${service}:${scope.region}:${scope.accountId}:${suffix}`;
  const probes = [
    { resource: `arn:aws:iam::${scope.accountId}:role/dg-${scope.projectId.replaceAll("-", "").slice(0, 12)}-execution`, actions: ["iam:DeleteRolePermissionsBoundary"] },
    { resource: regional("ecs", `service/${foreignName}/${foreignName}-application`), actions: ["ecs:UpdateService", "ecs:DeleteService"] },
    { resource: regional("ecs", `cluster/${foreignName}`), actions: ["ecs:UpdateCluster", "ecs:DeleteCluster"] },
    { resource: regional("ecs", `task-definition/${foreignName}-application:1`), actions: ["ecs:DeregisterTaskDefinition", "ecs:DeleteTaskDefinitions"] },
    { resource: regional("ecr", "repository/deployguard-ffffffffffff-application"), actions: ["ecr:PutImage", "ecr:BatchDeleteImage", "ecr:DeleteRepository"] },
    { resource: regional("logs", `log-group:/deployguard/${foreign}/services/application:*`), actions: ["logs:DeleteLogGroup", "logs:PutRetentionPolicy"] },
    { resource: regional("secretsmanager", `secret:deployguard/${foreign}/${scope.environmentName}/services/application/runtime-abcdef`), actions: ["secretsmanager:PutSecretValue", "secretsmanager:DeleteSecret"] },
    { resource: `arn:aws:iam::${scope.accountId}:role/${foreignName}-execution`, actions: ["iam:PutRolePolicy", "iam:DeleteRole", "iam:PassRole"] },
    { resource: `arn:aws:s3:::${scope.terraformStateBucket}/projects/${foreign}/${scope.environmentName}/runtime/terraform.tfstate`, actions: ["s3:PutObject", "s3:DeleteObject"] },
    { resource: regional("ec2", "security-group/sg-fffffffffffffffff"), actions: ["ec2:DeleteSecurityGroup", "ec2:AuthorizeSecurityGroupIngress"] },
    { resource: regional("elasticloadbalancing", `loadbalancer/app/${foreignName}-application/ffffffffffffffff`), actions: ["elasticloadbalancing:DeleteLoadBalancer", "elasticloadbalancing:SetSecurityGroups"] },
    { resource: regional("elasticloadbalancing", `targetgroup/${foreignName}-application/ffffffffffffffff`), actions: ["elasticloadbalancing:DeleteTargetGroup", "elasticloadbalancing:RegisterTargets"] },
    ...(scope.managedDatabaseEnabled ? [{ resource: regional("elasticfilesystem", "file-system/fs-fffffffffffffffff"), actions: ["elasticfilesystem:DeleteFileSystem", "elasticfilesystem:CreateMountTarget"] }] : []),
  ];
  const violations: string[] = [];
  for (const probe of probes) {
    const response = await client.send(new SimulatePrincipalPolicyCommand({ PolicySourceArn: roleArn, ActionNames: probe.actions, ResourceArns: [probe.resource],
      ContextEntries: Object.entries({ "aws:RequestedRegion": scope.region, "aws:ResourceAccount": scope.accountId, "aws:ResourceTag/DeployGuardProjectId": foreign, "aws:RequestTag/DeployGuardProjectId": foreign, "aws:ResourceTag/ManagedBy": "DeployGuard", "ecs:cluster": regional("ecs", `cluster/${foreignName}`) }).map(([ContextKeyName, value]) => ({ ContextKeyName, ContextKeyType: "string", ContextKeyValues: [value] })),
    }), { abortSignal: signal });
    if (response.IsTruncated) throw new Error("Customer IAM isolation simulation is incomplete.");
    for (const action of probe.actions) {
      const matches = (response.EvaluationResults || []).filter((result: any) => result.EvalActionName === action && result.EvalResourceName === probe.resource);
      if (matches.length !== 1 || !["implicitDeny", "explicitDeny"].includes(matches[0].EvalDecision) || matches[0].MissingContextValues?.length) violations.push(action);
    }
  }
  return [...new Set(violations)].sort();
}
