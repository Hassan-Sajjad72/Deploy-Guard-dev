import { createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";

export type WorkflowLifecycleAction = "deploy" | "destroy" | "rollback" | "promote" | "compensate";

export type WorkflowAwsCapabilityScope = {
  accountId: string;
  region: string;
  projectId: string;
  environmentName: string;
  generationId: string;
  terraformStateBucket: string;
  vpcId: string;
  sharedEcsClusterArn: string;
  sharedAlbArn: string;
  sharedAlbListenerArn: string;
};

export type WorkflowAwsCapability = {
  id: string;
  area: "sts" | "ecr" | "ecs" | "ec2" | "elbv2" | "logs" | "iam" | "secrets" | "efs" | "service-discovery" | "s3";
  actions: readonly string[];
  paths: readonly WorkflowLifecycleAction[];
  actionsByPath?: Partial<Record<WorkflowLifecycleAction, readonly string[]>>;
  resources: (scope: WorkflowAwsCapabilityScope) => string[];
  /** Stable platform-role scope. `resources` remains the concrete probe scope. */
  policyResources?: (scope: WorkflowAwsCapabilityScope) => string[];
  condition?: (scope: WorkflowAwsCapabilityScope) => Record<string, Record<string, string | string[]>>;
  policyCondition?: (scope: WorkflowAwsCapabilityScope) => Record<string, Record<string, string | string[]>>;
  simulationContext?: (scope: WorkflowAwsCapabilityScope) => Record<string, string[]>;
  simulationResources?: (scope: WorkflowAwsCapabilityScope, action: string) => string[];
};

const ALL = ["deploy", "destroy", "rollback", "promote", "compensate"] as const;
const TERRAFORM_PATHS = ["deploy", "destroy", "rollback"] as const;
const DEPLOY_DESTROY = ["deploy", "destroy"] as const;
const projectPrefix = (scope: WorkflowAwsCapabilityScope) => `dg-${scope.projectId.toLowerCase().replace(/_/g, "-").slice(0, 25)}`;
const clusterName = (scope: WorkflowAwsCapabilityScope) => scope.sharedEcsClusterArn.split("/").pop()!;
const deterministicServiceName = (scope: WorkflowAwsCapabilityScope) => `dg-${scope.projectId.slice(0, 8)}-${scope.generationId.slice(0, 8)}`.toLowerCase();
const deterministicTargetGroupName = (scope: WorkflowAwsCapabilityScope) => `${deterministicServiceName(scope).slice(0, 6)}simulation`.slice(0, 32);
const deterministicListenerRuleArn = (scope: WorkflowAwsCapabilityScope) => {
  const [name, loadBalancerId, listenerId] = scope.sharedAlbListenerArn.split("/").slice(-3);
  return `arn:aws:elasticloadbalancing:${scope.region}:${scope.accountId}:listener-rule/app/${name}/${loadBalancerId}/${listenerId}/0000000000000000`;
};
const ownershipCondition = (scope: WorkflowAwsCapabilityScope, prefix: "aws:RequestTag" | "aws:ResourceTag") => ({
  StringEquals: {
    [`${prefix}/ManagedBy`]: "DeployGuard",
    [`${prefix}/DeployGuardProjectId`]: scope.projectId,
    [`${prefix}/Environment`]: scope.environmentName,
    [`${prefix}/DeployGuardGenerationId`]: scope.generationId,
  },
});
const ownershipContext = (scope: WorkflowAwsCapabilityScope, prefix: "aws:RequestTag" | "aws:ResourceTag") => ({
  [`${prefix}/ManagedBy`]: ["DeployGuard"],
  [`${prefix}/DeployGuardProjectId`]: [scope.projectId],
  [`${prefix}/Environment`]: [scope.environmentName],
  [`${prefix}/DeployGuardGenerationId`]: [scope.generationId],
});
const projectOwnershipCondition = (scope: WorkflowAwsCapabilityScope, prefix: "aws:RequestTag" | "aws:ResourceTag") => ({
  StringEquals: {
    [`${prefix}/ManagedBy`]: "DeployGuard",
    [`${prefix}/DeployGuardProjectId`]: scope.projectId,
    [`${prefix}/Environment`]: scope.environmentName,
    [`${prefix}/DeployGuardScope`]: "project",
  },
});
const projectOwnershipContext = (scope: WorkflowAwsCapabilityScope, prefix: "aws:RequestTag" | "aws:ResourceTag") => ({
  [`${prefix}/ManagedBy`]: ["DeployGuard"],
  [`${prefix}/DeployGuardProjectId`]: [scope.projectId],
  [`${prefix}/Environment`]: [scope.environmentName],
  [`${prefix}/DeployGuardScope`]: ["project"],
});
const platformProjectOwnershipCondition = (prefix: "aws:RequestTag" | "aws:ResourceTag") => ({
  StringEquals: {
    [`${prefix}/ManagedBy`]: "DeployGuard",
    [`${prefix}/DeployGuardScope`]: "project",
  },
  StringLike: {
    [`${prefix}/DeployGuardProjectId`]: "*",
    [`${prefix}/Environment`]: "*",
  },
});

/**
 * Authoritative AWS capability contract for the published reusable workflow.
 * Policy rendering, effective-role simulation and drift tests all consume this
 * single declaration. Bump the version whenever a workflow AWS API dependency
 * changes.
 */
export const WORKFLOW_AWS_CAPABILITY_CONTRACT_VERSION = "deployguard.workflow-aws/v2";
export const WORKFLOW_AWS_CAPABILITIES: readonly WorkflowAwsCapability[] = [
  {
    id: "read-discovery",
    area: "sts",
    paths: ALL,
    actions: [
      "sts:GetCallerIdentity",
      "ecr:GetAuthorizationToken", "ecr:DescribeRepositories", "ecr:DescribeImages", "ecr:ListTagsForResource",
      "ecs:DescribeClusters", "ecs:ListClusters", "ecs:DescribeServices", "ecs:ListServices", "ecs:DescribeTaskDefinition", "ecs:DescribeTasks", "ecs:ListTaskDefinitions", "ecs:ListTasks", "ecs:ListTagsForResource",
      "ec2:DescribeAccountAttributes", "ec2:DescribeAddresses", "ec2:DescribeInternetGateways", "ec2:DescribeNatGateways", "ec2:DescribeNetworkInterfaces", "ec2:DescribeRegions", "ec2:DescribeRouteTables", "ec2:DescribeSecurityGroups", "ec2:DescribeSecurityGroupRules", "ec2:DescribeSubnets", "ec2:DescribeVpcAttribute", "ec2:DescribeVpcs",
      "elasticloadbalancing:DescribeTags", "elasticloadbalancing:DescribeLoadBalancers", "elasticloadbalancing:DescribeLoadBalancerAttributes", "elasticloadbalancing:DescribeTargetGroups", "elasticloadbalancing:DescribeTargetGroupAttributes", "elasticloadbalancing:DescribeListeners", "elasticloadbalancing:DescribeListenerAttributes", "elasticloadbalancing:DescribeRules", "elasticloadbalancing:DescribeTargetHealth",
      "logs:DescribeLogGroups",
      "iam:GetRole", "iam:GetRolePolicy", "iam:ListRolePolicies", "iam:ListAttachedRolePolicies", "iam:ListInstanceProfilesForRole",
      "secretsmanager:ListSecrets",
      "elasticfilesystem:DescribeFileSystems", "elasticfilesystem:DescribeAccessPoints", "elasticfilesystem:DescribeMountTargets", "elasticfilesystem:DescribeMountTargetSecurityGroups", "elasticfilesystem:DescribeLifecycleConfiguration",
      "servicediscovery:GetOperation", "servicediscovery:GetNamespace", "servicediscovery:GetService", "servicediscovery:GetServiceAttributes", "servicediscovery:ListNamespaces", "servicediscovery:ListServices", "servicediscovery:ListOperations", "servicediscovery:ListTagsForResource", "servicediscovery:ListInstances",
    ],
    actionsByPath: {
      promote: ["ecs:DescribeServices", "ecs:DescribeTaskDefinition", "ecs:DescribeTasks", "ecs:ListTasks", "elasticloadbalancing:DescribeRules", "elasticloadbalancing:DescribeTags", "elasticloadbalancing:DescribeTargetHealth"],
      compensate: ["elasticloadbalancing:DescribeRules", "elasticloadbalancing:DescribeTags"],
    },
    resources: () => ["*"],
  },
  {
    id: "terraform-state-bucket",
    area: "s3",
    paths: TERRAFORM_PATHS,
    actions: ["s3:ListBucket", "s3:ListBucketVersions"],
    resources: (scope) => [`arn:aws:s3:::${scope.terraformStateBucket}`],
    policyResources: (scope) => [`arn:aws:s3:::${scope.terraformStateBucket}`],
  },
  {
    id: "terraform-state-objects",
    area: "s3",
    paths: TERRAFORM_PATHS,
    actions: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:DeleteObjectVersion"],
    resources: (scope) => [
      `arn:aws:s3:::${scope.terraformStateBucket}/projects/${scope.projectId}/${scope.environmentName}/${scope.generationId}/*`,
      `arn:aws:s3:::${scope.terraformStateBucket}/projects/${scope.projectId}/${scope.environmentName}/project/*`,
    ],
    policyResources: (scope) => [`arn:aws:s3:::${scope.terraformStateBucket}/projects/*`],
  },
  {
    id: "logs",
    area: "logs",
    paths: TERRAFORM_PATHS,
    actions: ["logs:CreateLogGroup", "logs:ListTagsForResource", "logs:ListTagsLogGroup", "logs:PutRetentionPolicy", "logs:TagResource", "logs:UntagResource", "logs:DeleteLogGroup"],
    actionsByPath: {
      deploy: ["logs:CreateLogGroup", "logs:ListTagsForResource", "logs:PutRetentionPolicy", "logs:TagResource", "logs:UntagResource"],
      destroy: ["logs:ListTagsForResource", "logs:ListTagsLogGroup", "logs:UntagResource", "logs:DeleteLogGroup"],
      rollback: ["logs:ListTagsForResource", "logs:ListTagsLogGroup"],
    },
    resources: (scope) => [`arn:aws:logs:${scope.region}:${scope.accountId}:log-group:/deployguard/${scope.projectId}/${scope.environmentName}/${scope.generationId}/*`],
    policyResources: (scope) => [`arn:aws:logs:${scope.region}:${scope.accountId}:log-group:/deployguard/*`],
  },
  {
    id: "ecr",
    area: "ecr",
    paths: DEPLOY_DESTROY,
    actions: ["ecr:CreateRepository", "ecr:DeleteRepository", "ecr:BatchDeleteImage", "ecr:BatchCheckLayerAvailability", "ecr:GetDownloadUrlForLayer", "ecr:BatchGetImage", "ecr:PutImage", "ecr:InitiateLayerUpload", "ecr:UploadLayerPart", "ecr:CompleteLayerUpload", "ecr:TagResource", "ecr:UntagResource"],
    actionsByPath: {
      deploy: ["ecr:CreateRepository", "ecr:BatchDeleteImage", "ecr:BatchCheckLayerAvailability", "ecr:GetDownloadUrlForLayer", "ecr:BatchGetImage", "ecr:PutImage", "ecr:InitiateLayerUpload", "ecr:UploadLayerPart", "ecr:CompleteLayerUpload", "ecr:TagResource", "ecr:UntagResource"],
      destroy: ["ecr:DeleteRepository", "ecr:TagResource", "ecr:UntagResource"],
    },
    resources: (scope) => [`arn:aws:ecr:${scope.region}:${scope.accountId}:repository/deployguard-${scope.projectId.toLowerCase()}`],
    policyResources: (scope) => [`arn:aws:ecr:${scope.region}:${scope.accountId}:repository/deployguard-*`],
  },
  {
    id: "ecs",
    area: "ecs",
    paths: ALL,
    actions: ["ecs:CreateService", "ecs:UpdateService", "ecs:DeleteService", "ecs:StopTask", "ecs:TagResource", "ecs:UntagResource"],
    actionsByPath: {
      deploy: ["ecs:CreateService", "ecs:UpdateService", "ecs:TagResource", "ecs:UntagResource"],
      destroy: ["ecs:UpdateService", "ecs:DeleteService", "ecs:StopTask", "ecs:TagResource", "ecs:UntagResource"],
      rollback: ["ecs:UpdateService"],
      promote: [],
      compensate: [],
    },
    resources: (scope) => [
      scope.sharedEcsClusterArn,
      `arn:aws:ecs:${scope.region}:${scope.accountId}:service/${clusterName(scope)}/${deterministicServiceName(scope)}`,
      `arn:aws:ecs:${scope.region}:${scope.accountId}:task/${clusterName(scope)}/*`,
      `arn:aws:ecs:${scope.region}:${scope.accountId}:task-definition/${projectPrefix(scope)}*`,
    ],
    policyResources: (scope) => [
      `arn:aws:ecs:${scope.region}:${scope.accountId}:cluster/dg-*`,
      `arn:aws:ecs:${scope.region}:${scope.accountId}:service/dg-*/*`,
      `arn:aws:ecs:${scope.region}:${scope.accountId}:task/dg-*/*`,
      `arn:aws:ecs:${scope.region}:${scope.accountId}:task-definition/dg-*`,
    ],
    simulationResources: (scope, action) => {
      if (action === "ecs:TagResource" || action === "ecs:UntagResource") return [
        scope.sharedEcsClusterArn,
        `arn:aws:ecs:${scope.region}:${scope.accountId}:service/${clusterName(scope)}/${deterministicServiceName(scope)}`,
        `arn:aws:ecs:${scope.region}:${scope.accountId}:task-definition/${projectPrefix(scope)}:1`,
      ];
      if (action.includes("TaskDefinition")) return [`arn:aws:ecs:${scope.region}:${scope.accountId}:task-definition/${projectPrefix(scope)}:1`];
      if (action === "ecs:StopTask") return [`arn:aws:ecs:${scope.region}:${scope.accountId}:task/${clusterName(scope)}/00000000000000000000000000000000`];
      if (action.includes("Service")) return [`arn:aws:ecs:${scope.region}:${scope.accountId}:service/${clusterName(scope)}/${deterministicServiceName(scope)}`];
      return [scope.sharedEcsClusterArn];
    },
  },
  {
    id: "ecs-register-task-definition",
    area: "ecs",
    paths: ["deploy", "rollback"],
    actions: ["ecs:RegisterTaskDefinition"],
    resources: () => ["*"],
  },
  {
    id: "ecs-deregister-task-definition",
    area: "ecs",
    paths: ["destroy"],
    actions: ["ecs:DeregisterTaskDefinition", "ecs:DeleteTaskDefinitions"],
    resources: () => ["*"],
  },
  {
    id: "network-create-security-group",
    area: "ec2",
    paths: ["deploy"],
    actions: ["ec2:CreateSecurityGroup"],
    resources: (scope) => [
      `arn:aws:ec2:${scope.region}:${scope.accountId}:vpc/${scope.vpcId}`,
      `arn:aws:ec2:${scope.region}:${scope.accountId}:security-group/*`,
    ],
  },
  {
    id: "network",
    area: "ec2",
    paths: DEPLOY_DESTROY,
    actions: ["ec2:DeleteSecurityGroup", "ec2:AuthorizeSecurityGroupIngress", "ec2:AuthorizeSecurityGroupEgress", "ec2:RevokeSecurityGroupIngress", "ec2:RevokeSecurityGroupEgress", "ec2:CreateTags", "ec2:DeleteTags"],
    actionsByPath: {
      deploy: ["ec2:AuthorizeSecurityGroupIngress", "ec2:AuthorizeSecurityGroupEgress", "ec2:RevokeSecurityGroupIngress", "ec2:RevokeSecurityGroupEgress", "ec2:CreateTags", "ec2:DeleteTags"],
      destroy: ["ec2:DeleteSecurityGroup", "ec2:RevokeSecurityGroupIngress", "ec2:RevokeSecurityGroupEgress", "ec2:DeleteTags"],
    },
    resources: (scope) => [`arn:aws:ec2:${scope.region}:${scope.accountId}:security-group/*`],
  },
  {
    id: "load-balancing",
    area: "elbv2",
    paths: ALL,
    actions: ["elasticloadbalancing:AddTags", "elasticloadbalancing:RemoveTags", "elasticloadbalancing:CreateTargetGroup", "elasticloadbalancing:DeleteTargetGroup", "elasticloadbalancing:ModifyTargetGroup", "elasticloadbalancing:ModifyTargetGroupAttributes", "elasticloadbalancing:CreateRule", "elasticloadbalancing:DeleteRule", "elasticloadbalancing:ModifyRule", "elasticloadbalancing:SetRulePriorities"],
    actionsByPath: {
      deploy: ["elasticloadbalancing:AddTags", "elasticloadbalancing:RemoveTags", "elasticloadbalancing:CreateTargetGroup", "elasticloadbalancing:ModifyTargetGroup", "elasticloadbalancing:ModifyTargetGroupAttributes", "elasticloadbalancing:CreateRule", "elasticloadbalancing:ModifyRule", "elasticloadbalancing:SetRulePriorities"],
      destroy: ["elasticloadbalancing:RemoveTags", "elasticloadbalancing:DeleteTargetGroup", "elasticloadbalancing:DeleteRule"],
      rollback: [],
      // Promotion deletes only its exact, generation-owned candidate rule
      // after the stable route has been verified. The production rule remains
      // outside this capability scope.
      promote: ["elasticloadbalancing:CreateRule", "elasticloadbalancing:ModifyRule", "elasticloadbalancing:DeleteRule"],
      compensate: ["elasticloadbalancing:ModifyRule", "elasticloadbalancing:DeleteRule"],
    },
    resources: (scope) => [
      scope.sharedAlbArn,
      `arn:aws:elasticloadbalancing:${scope.region}:${scope.accountId}:targetgroup/${deterministicTargetGroupName(scope)}/0000000000000000`,
      scope.sharedAlbListenerArn,
      deterministicListenerRuleArn(scope),
    ],
    policyResources: (scope) => [
      `arn:aws:elasticloadbalancing:${scope.region}:${scope.accountId}:loadbalancer/app/dg-*/*`,
      `arn:aws:elasticloadbalancing:${scope.region}:${scope.accountId}:targetgroup/*/*`,
      `arn:aws:elasticloadbalancing:${scope.region}:${scope.accountId}:listener/app/dg-*/*/*`,
      `arn:aws:elasticloadbalancing:${scope.region}:${scope.accountId}:listener-rule/app/dg-*/*/*/*`,
    ],
    simulationResources: (scope, action) => {
      if (action === "elasticloadbalancing:AddTags" || action === "elasticloadbalancing:RemoveTags") return [
        scope.sharedAlbArn,
        `arn:aws:elasticloadbalancing:${scope.region}:${scope.accountId}:targetgroup/${deterministicTargetGroupName(scope)}/0000000000000000`,
        scope.sharedAlbListenerArn,
      ];
      if (action.includes("TargetGroup")) return [`arn:aws:elasticloadbalancing:${scope.region}:${scope.accountId}:targetgroup/${deterministicTargetGroupName(scope)}/0000000000000000`];
      if (action === "elasticloadbalancing:CreateRule") return [scope.sharedAlbListenerArn];
      if (["elasticloadbalancing:ModifyRule", "elasticloadbalancing:SetRulePriorities", "elasticloadbalancing:DeleteRule"].includes(action)) return [deterministicListenerRuleArn(scope)];
      if (action.includes("Listener")) return [scope.sharedAlbListenerArn];
      return [scope.sharedAlbArn];
    },
  },
  {
    id: "execution-roles",
    area: "iam",
    paths: TERRAFORM_PATHS,
    actions: ["iam:CreateRole", "iam:DeleteRole", "iam:PutRolePolicy", "iam:DeleteRolePolicy", "iam:DetachRolePolicy", "iam:RemoveRoleFromInstanceProfile", "iam:PassRole", "iam:TagRole", "iam:UntagRole"],
    actionsByPath: {
      deploy: ["iam:CreateRole", "iam:PutRolePolicy", "iam:DeleteRolePolicy", "iam:PassRole", "iam:TagRole", "iam:UntagRole"],
      destroy: ["iam:DeleteRole", "iam:DeleteRolePolicy", "iam:DetachRolePolicy", "iam:RemoveRoleFromInstanceProfile", "iam:UntagRole"],
      rollback: ["iam:PassRole"],
    },
    resources: (scope) => [`arn:aws:iam::${scope.accountId}:role/${projectPrefix(scope)}*`, `arn:aws:iam::${scope.accountId}:policy/${projectPrefix(scope)}*`, `arn:aws:iam::${scope.accountId}:instance-profile/${projectPrefix(scope)}*`],
    policyResources: (scope) => [`arn:aws:iam::${scope.accountId}:role/dg-*`, `arn:aws:iam::${scope.accountId}:policy/dg-*`, `arn:aws:iam::${scope.accountId}:instance-profile/dg-*`],
  },
  {
    id: "managed-secrets",
    area: "secrets",
    paths: DEPLOY_DESTROY,
    actions: ["secretsmanager:CreateSecret", "secretsmanager:DescribeSecret", "secretsmanager:PutSecretValue", "secretsmanager:GetSecretValue", "secretsmanager:GetResourcePolicy", "secretsmanager:ListSecretVersionIds", "secretsmanager:UpdateSecret", "secretsmanager:UpdateSecretVersionStage", "secretsmanager:TagResource", "secretsmanager:UntagResource", "secretsmanager:DeleteSecret", "secretsmanager:RestoreSecret"],
    actionsByPath: {
      deploy: ["secretsmanager:CreateSecret", "secretsmanager:DescribeSecret", "secretsmanager:PutSecretValue", "secretsmanager:GetSecretValue", "secretsmanager:GetResourcePolicy", "secretsmanager:ListSecretVersionIds", "secretsmanager:UpdateSecret", "secretsmanager:UpdateSecretVersionStage", "secretsmanager:TagResource", "secretsmanager:UntagResource", "secretsmanager:RestoreSecret"],
      destroy: ["secretsmanager:DescribeSecret", "secretsmanager:GetResourcePolicy", "secretsmanager:ListSecretVersionIds", "secretsmanager:UntagResource", "secretsmanager:DeleteSecret"],
    },
    resources: (scope) => [`arn:aws:secretsmanager:${scope.region}:${scope.accountId}:secret:deployguard/${scope.projectId}/${scope.environmentName}/*`],
    policyResources: (scope) => [`arn:aws:secretsmanager:${scope.region}:${scope.accountId}:secret:deployguard/*`],
  },
  {
    id: "efs-existing",
    area: "efs",
    paths: DEPLOY_DESTROY,
    actions: ["elasticfilesystem:PutLifecycleConfiguration", "elasticfilesystem:UpdateFileSystem", "elasticfilesystem:TagResource", "elasticfilesystem:UntagResource", "elasticfilesystem:DeleteAccessPoint", "elasticfilesystem:DeleteMountTarget", "elasticfilesystem:DeleteFileSystem"],
    actionsByPath: {
      deploy: ["elasticfilesystem:PutLifecycleConfiguration", "elasticfilesystem:UpdateFileSystem", "elasticfilesystem:TagResource", "elasticfilesystem:UntagResource"],
      destroy: ["elasticfilesystem:UntagResource", "elasticfilesystem:DeleteAccessPoint", "elasticfilesystem:DeleteMountTarget", "elasticfilesystem:DeleteFileSystem"],
    },
    resources: (scope) => [`arn:aws:elasticfilesystem:${scope.region}:${scope.accountId}:file-system/*`, `arn:aws:elasticfilesystem:${scope.region}:${scope.accountId}:access-point/*`],
    condition: (scope) => projectOwnershipCondition(scope, "aws:ResourceTag"),
    policyCondition: () => platformProjectOwnershipCondition("aws:ResourceTag"),
    simulationContext: (scope) => projectOwnershipContext(scope, "aws:ResourceTag"),
    simulationResources: (scope, action) => action.includes("AccessPoint")
      ? [`arn:aws:elasticfilesystem:${scope.region}:${scope.accountId}:access-point/fsap-deployguardsimulation`]
      : [`arn:aws:elasticfilesystem:${scope.region}:${scope.accountId}:file-system/fs-deployguardsimulation`],
  },
  {
    id: "efs-create",
    area: "efs",
    paths: ["deploy"],
    actions: ["elasticfilesystem:CreateFileSystem"],
    resources: () => ["*"],
    condition: (scope) => projectOwnershipCondition(scope, "aws:RequestTag"),
    policyCondition: () => platformProjectOwnershipCondition("aws:RequestTag"),
    simulationContext: (scope) => projectOwnershipContext(scope, "aws:RequestTag"),
  },
  {
    id: "efs-children",
    area: "efs",
    paths: ["deploy"],
    actions: ["elasticfilesystem:CreateAccessPoint", "elasticfilesystem:CreateMountTarget"],
    resources: (scope) => [`arn:aws:elasticfilesystem:${scope.region}:${scope.accountId}:file-system/*`],
    condition: (scope) => projectOwnershipCondition(scope, "aws:ResourceTag"),
    policyCondition: () => platformProjectOwnershipCondition("aws:ResourceTag"),
    simulationContext: (scope) => projectOwnershipContext(scope, "aws:ResourceTag"),
  },
  {
    id: "service-discovery",
    area: "service-discovery",
    paths: DEPLOY_DESTROY,
    actions: ["servicediscovery:CreatePrivateDnsNamespace", "servicediscovery:CreateService", "servicediscovery:UpdatePrivateDnsNamespace", "servicediscovery:DeleteNamespace", "servicediscovery:UpdateService", "servicediscovery:UpdateServiceAttributes", "servicediscovery:DeleteService", "servicediscovery:DeleteServiceAttributes", "servicediscovery:TagResource", "servicediscovery:UntagResource", "route53:CreateHostedZone", "route53:GetHostedZone", "route53:ListHostedZonesByName"],
    actionsByPath: {
      deploy: ["servicediscovery:CreatePrivateDnsNamespace", "servicediscovery:CreateService", "servicediscovery:UpdatePrivateDnsNamespace", "servicediscovery:UpdateService", "servicediscovery:UpdateServiceAttributes", "servicediscovery:TagResource", "servicediscovery:UntagResource", "route53:CreateHostedZone", "route53:GetHostedZone", "route53:ListHostedZonesByName"],
      destroy: ["servicediscovery:DeleteNamespace", "servicediscovery:DeleteService", "servicediscovery:DeleteServiceAttributes", "servicediscovery:UntagResource"],
    },
    resources: () => ["*"],
  },
] as const;

export function capabilitiesFor(action: WorkflowLifecycleAction) {
  return WORKFLOW_AWS_CAPABILITIES
    .filter((capability) => capability.paths.includes(action as never))
    .map((capability) => capability.actionsByPath?.[action]
      ? { ...capability, actions: capability.actionsByPath[action]! }
      : capability);
}

export function workflowCapabilityPolicy(scope: WorkflowAwsCapabilityScope, onlyActions?: ReadonlySet<string>) {
  return {
    Version: "2012-10-17",
    Statement: WORKFLOW_AWS_CAPABILITIES.flatMap((capability, index) => {
      const actions = capability.actions.filter((action) => !onlyActions || onlyActions.has(action));
      return actions.length ? [{
        Sid: `DeployGuard${String(index + 1).padStart(2, "0")}${capability.id.replace(/[^A-Za-z0-9]/g, "")}`.slice(0, 128),
        Effect: "Allow",
        Action: actions,
        Resource: (capability.policyResources || capability.resources)(scope),
        ...((capability.policyCondition || capability.condition) ? { Condition: (capability.policyCondition || capability.condition)!(scope) } : {}),
      }] : [];
    }),
  };
}

export function workflowCapabilityFingerprint() {
  const fingerprintScope: WorkflowAwsCapabilityScope = {
    accountId: "000000000000",
    region: "us-east-1",
    projectId: "00000000-0000-4000-8000-000000000000",
    environmentName: "dev",
    generationId: "11111111-1111-4111-8111-111111111111",
    terraformStateBucket: "deployguard-contract-state",
    vpcId: "vpc-00000000000000000",
    sharedEcsClusterArn: "arn:aws:ecs:us-east-1:000000000000:cluster/dg-shared-platform",
    sharedAlbArn: "arn:aws:elasticloadbalancing:us-east-1:000000000000:loadbalancer/app/dg-shared-platform/0000000000000000",
    sharedAlbListenerArn: "arn:aws:elasticloadbalancing:us-east-1:000000000000:listener/app/dg-shared-platform/0000000000000000/0000000000000000",
  };
  const canonical = {
    capabilities: WORKFLOW_AWS_CAPABILITIES.map(({ id, area, actions, paths, actionsByPath }) => ({ id, area, actions: [...actions].sort(), paths: [...paths].sort(), actionsByPath })),
    policy: workflowCapabilityPolicy(fingerprintScope),
  };
  return createHash("sha256").update(`${WORKFLOW_AWS_CAPABILITY_CONTRACT_VERSION}:${JSON.stringify(canonical)}`).digest("hex");
}

const capabilityModuleLoadedAt = Date.now();

/** Local stale-process guard. Production images normally contain only the
 * compiled module; a local checkout also checks the authoritative TypeScript
 * source. A process loaded before either file changed must not dispatch. */
export function workflowCapabilityRuntimeStatus() {
  const candidates = [
    __filename,
    resolve(process.cwd(), "src/projects/github-actions-aws-capability-contract.ts"),
    resolve(process.cwd(), "backend/src/projects/github-actions-aws-capability-contract.ts"),
  ];
  const changedFiles = [...new Set(candidates)]
    .filter((file) => existsSync(file) && statSync(file).mtimeMs > capabilityModuleLoadedAt + 1_000);
  return {
    version: WORKFLOW_AWS_CAPABILITY_CONTRACT_VERSION,
    fingerprint: workflowCapabilityFingerprint(),
    stale: changedFiles.length > 0,
    changedFiles,
  };
}
