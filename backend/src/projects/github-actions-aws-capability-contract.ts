import { createHash } from "node:crypto";

export type WorkflowLifecycleAction = "deploy" | "destroy" | "rollback";

export type WorkflowAwsCapabilityScope = {
  accountId: string;
  region: string;
  projectId: string;
  environmentName: string;
  generationId: string;
  terraformStateBucket: string;
  vpcId: string;
};

export type WorkflowAwsCapability = {
  id: string;
  area: "sts" | "ecr" | "ecs" | "ec2" | "elbv2" | "logs" | "iam" | "secrets" | "efs" | "service-discovery" | "s3" | "tagging" | "ssm" | "backup" | "sns";
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

const ALL = ["deploy", "destroy", "rollback"] as const;
const DEPLOY_DESTROY = ["deploy", "destroy"] as const;
const projectPrefix = (scope: WorkflowAwsCapabilityScope) => `dg-${scope.projectId.toLowerCase().replace(/_/g, "-").slice(0, 25)}`;
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
const platformOwnershipCondition = (prefix: "aws:RequestTag" | "aws:ResourceTag") => ({
  StringEquals: { [`${prefix}/ManagedBy`]: "DeployGuard" },
  StringLike: {
    [`${prefix}/DeployGuardProjectId`]: "*",
    [`${prefix}/Environment`]: "*",
    [`${prefix}/DeployGuardGenerationId`]: "*",
  },
});

/**
 * Authoritative AWS capability contract for the published reusable workflow.
 * Policy rendering, effective-role simulation and drift tests all consume this
 * single declaration. Bump the version whenever a workflow AWS API dependency
 * changes.
 */
export const WORKFLOW_AWS_CAPABILITY_CONTRACT_VERSION = "deployguard.workflow-aws/v1";
export const WORKFLOW_AWS_CAPABILITIES: readonly WorkflowAwsCapability[] = [
  {
    id: "read-discovery",
    area: "sts",
    paths: ALL,
    actions: [
      "sts:GetCallerIdentity",
      "ecr:GetAuthorizationToken", "ecr:DescribeRepositories", "ecr:DescribeImages", "ecr:ListTagsForResource",
      "ecs:DescribeClusters", "ecs:ListClusters", "ecs:DescribeServices", "ecs:ListServices", "ecs:DescribeTaskDefinition", "ecs:ListTaskDefinitions", "ecs:ListTasks", "ecs:ListTagsForResource",
      "ec2:DescribeAccountAttributes", "ec2:DescribeAddresses", "ec2:DescribeInternetGateways", "ec2:DescribeNatGateways", "ec2:DescribeNetworkInterfaces", "ec2:DescribeRouteTables", "ec2:DescribeSecurityGroups", "ec2:DescribeSecurityGroupRules", "ec2:DescribeSubnets", "ec2:DescribeVpcs",
      "elasticloadbalancing:DescribeTags", "elasticloadbalancing:DescribeLoadBalancers", "elasticloadbalancing:DescribeLoadBalancerAttributes", "elasticloadbalancing:DescribeTargetGroups", "elasticloadbalancing:DescribeTargetGroupAttributes", "elasticloadbalancing:DescribeListeners", "elasticloadbalancing:DescribeListenerAttributes", "elasticloadbalancing:DescribeTargetHealth",
      "logs:DescribeLogGroups",
      "iam:GetRole", "iam:GetRolePolicy", "iam:ListRolePolicies", "iam:ListAttachedRolePolicies", "iam:ListInstanceProfilesForRole", "iam:ListEntitiesForPolicy", "iam:ListPolicyVersions",
      "secretsmanager:ListSecrets",
      "elasticfilesystem:DescribeFileSystems", "elasticfilesystem:DescribeAccessPoints", "elasticfilesystem:DescribeMountTargets", "elasticfilesystem:DescribeMountTargetSecurityGroups", "elasticfilesystem:DescribeLifecycleConfiguration",
      "servicediscovery:GetOperation", "servicediscovery:GetNamespace", "servicediscovery:GetService", "servicediscovery:GetServiceAttributes", "servicediscovery:ListNamespaces", "servicediscovery:ListServices", "servicediscovery:ListOperations", "servicediscovery:ListTagsForResource", "servicediscovery:ListInstances",
      "tag:GetResources",
    ],
    actionsByPath: {
      rollback: ["ecs:DescribeServices", "ecs:DescribeTaskDefinition", "ecs:ListTagsForResource", "elasticloadbalancing:DescribeLoadBalancers", "elasticloadbalancing:DescribeTargetGroups", "elasticloadbalancing:DescribeTargetHealth"],
    },
    resources: () => ["*"],
  },
  {
    id: "terraform-state-bucket",
    area: "s3",
    paths: DEPLOY_DESTROY,
    actions: ["s3:ListBucket", "s3:ListBucketVersions"],
    resources: (scope) => [`arn:aws:s3:::${scope.terraformStateBucket}`],
    policyResources: (scope) => [`arn:aws:s3:::${scope.terraformStateBucket}`],
  },
  {
    id: "terraform-state-objects",
    area: "s3",
    paths: DEPLOY_DESTROY,
    actions: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:DeleteObjectVersion"],
    resources: (scope) => [`arn:aws:s3:::${scope.terraformStateBucket}/projects/${scope.projectId}/${scope.environmentName}/${scope.generationId}/*`],
    policyResources: (scope) => [`arn:aws:s3:::${scope.terraformStateBucket}/projects/*`],
  },
  {
    id: "logs",
    area: "logs",
    paths: DEPLOY_DESTROY,
    actions: ["logs:CreateLogGroup", "logs:ListTagsForResource", "logs:ListTagsLogGroup", "logs:PutRetentionPolicy", "logs:TagResource", "logs:UntagResource", "logs:DeleteLogGroup"],
    actionsByPath: {
      deploy: ["logs:CreateLogGroup", "logs:ListTagsForResource", "logs:PutRetentionPolicy", "logs:TagResource", "logs:UntagResource"],
      destroy: ["logs:ListTagsForResource", "logs:ListTagsLogGroup", "logs:UntagResource", "logs:DeleteLogGroup"],
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
    resources: (scope) => [`arn:aws:ecr:${scope.region}:${scope.accountId}:repository/deployguard-${scope.projectId.toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 28)}`],
    policyResources: (scope) => [`arn:aws:ecr:${scope.region}:${scope.accountId}:repository/deployguard-*`],
  },
  {
    id: "ecs",
    area: "ecs",
    paths: ALL,
    actions: ["ecs:CreateCluster", "ecs:DeleteCluster", "ecs:CreateService", "ecs:UpdateService", "ecs:DeleteService", "ecs:StopTask", "ecs:TagResource", "ecs:UntagResource"],
    actionsByPath: {
      deploy: ["ecs:CreateCluster", "ecs:CreateService", "ecs:UpdateService", "ecs:TagResource", "ecs:UntagResource"],
      destroy: ["ecs:DeleteCluster", "ecs:UpdateService", "ecs:DeleteService", "ecs:StopTask", "ecs:TagResource", "ecs:UntagResource"],
      rollback: ["ecs:UpdateService"],
    },
    resources: (scope) => [
      `arn:aws:ecs:${scope.region}:${scope.accountId}:cluster/${projectPrefix(scope)}`,
      `arn:aws:ecs:${scope.region}:${scope.accountId}:service/${projectPrefix(scope)}/*`,
      `arn:aws:ecs:${scope.region}:${scope.accountId}:task/${projectPrefix(scope)}/*`,
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
        `arn:aws:ecs:${scope.region}:${scope.accountId}:cluster/${projectPrefix(scope)}`,
        `arn:aws:ecs:${scope.region}:${scope.accountId}:service/${projectPrefix(scope)}/${projectPrefix(scope)}`,
        `arn:aws:ecs:${scope.region}:${scope.accountId}:task-definition/${projectPrefix(scope)}:1`,
      ];
      if (action.includes("TaskDefinition")) return [`arn:aws:ecs:${scope.region}:${scope.accountId}:task-definition/${projectPrefix(scope)}:1`];
      if (action === "ecs:StopTask") return [`arn:aws:ecs:${scope.region}:${scope.accountId}:task/${projectPrefix(scope)}/00000000000000000000000000000000`];
      if (action.includes("Service")) return [`arn:aws:ecs:${scope.region}:${scope.accountId}:service/${projectPrefix(scope)}/${projectPrefix(scope)}`];
      return [`arn:aws:ecs:${scope.region}:${scope.accountId}:cluster/${projectPrefix(scope)}`];
    },
  },
  {
    id: "ecs-register-task-definition",
    area: "ecs",
    paths: ["deploy"],
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
    id: "owned-network-extinction",
    area: "ec2",
    paths: ["destroy"],
    actions: [
      "ec2:DeleteNetworkInterface", "ec2:DeleteNatGateway", "ec2:ReleaseAddress",
      "ec2:DeleteSubnet", "ec2:DisassociateRouteTable", "ec2:DeleteRouteTable",
      "ec2:DetachInternetGateway", "ec2:DeleteInternetGateway", "ec2:DeleteVpc",
    ],
    resources: (scope) => [
      `arn:aws:ec2:${scope.region}:${scope.accountId}:network-interface/*`,
      `arn:aws:ec2:${scope.region}:${scope.accountId}:natgateway/*`,
      `arn:aws:ec2:${scope.region}:${scope.accountId}:elastic-ip/*`,
      `arn:aws:ec2:${scope.region}:${scope.accountId}:subnet/*`,
      `arn:aws:ec2:${scope.region}:${scope.accountId}:route-table/*`,
      `arn:aws:ec2:${scope.region}:${scope.accountId}:internet-gateway/*`,
      `arn:aws:ec2:${scope.region}:${scope.accountId}:vpc/*`,
    ],
    policyResources: (scope) => [
      `arn:aws:ec2:${scope.region}:${scope.accountId}:network-interface/*`,
      `arn:aws:ec2:${scope.region}:${scope.accountId}:natgateway/*`,
      `arn:aws:ec2:${scope.region}:${scope.accountId}:elastic-ip/*`,
      `arn:aws:ec2:${scope.region}:${scope.accountId}:subnet/*`,
      `arn:aws:ec2:${scope.region}:${scope.accountId}:route-table/*`,
      `arn:aws:ec2:${scope.region}:${scope.accountId}:internet-gateway/*`,
      `arn:aws:ec2:${scope.region}:${scope.accountId}:vpc/*`,
    ],
    condition: (scope) => ownershipCondition(scope, "aws:ResourceTag"),
    policyCondition: () => platformOwnershipCondition("aws:ResourceTag"),
    simulationContext: (scope) => ownershipContext(scope, "aws:ResourceTag"),
    simulationResources: (scope, action) => {
      const kind = action.includes("NetworkInterface") ? "network-interface"
        : action.includes("NatGateway") ? "natgateway"
          : action.includes("Address") ? "elastic-ip"
            : action.includes("Subnet") ? "subnet"
              : action.includes("RouteTable") ? "route-table"
                : action.includes("InternetGateway") ? "internet-gateway"
                  : "vpc";
      return [`arn:aws:ec2:${scope.region}:${scope.accountId}:${kind}/deployguard-simulation`];
    },
  },
  {
    id: "load-balancing",
    area: "elbv2",
    paths: DEPLOY_DESTROY,
    actions: ["elasticloadbalancing:AddTags", "elasticloadbalancing:RemoveTags", "elasticloadbalancing:CreateLoadBalancer", "elasticloadbalancing:DeleteLoadBalancer", "elasticloadbalancing:ModifyLoadBalancerAttributes", "elasticloadbalancing:SetSecurityGroups", "elasticloadbalancing:SetSubnets", "elasticloadbalancing:CreateTargetGroup", "elasticloadbalancing:DeleteTargetGroup", "elasticloadbalancing:ModifyTargetGroup", "elasticloadbalancing:ModifyTargetGroupAttributes", "elasticloadbalancing:CreateListener", "elasticloadbalancing:DeleteListener", "elasticloadbalancing:DeleteRule", "elasticloadbalancing:ModifyListener", "elasticloadbalancing:ModifyListenerAttributes"],
    actionsByPath: {
      deploy: ["elasticloadbalancing:AddTags", "elasticloadbalancing:RemoveTags", "elasticloadbalancing:CreateLoadBalancer", "elasticloadbalancing:ModifyLoadBalancerAttributes", "elasticloadbalancing:SetSecurityGroups", "elasticloadbalancing:SetSubnets", "elasticloadbalancing:CreateTargetGroup", "elasticloadbalancing:ModifyTargetGroup", "elasticloadbalancing:ModifyTargetGroupAttributes", "elasticloadbalancing:CreateListener", "elasticloadbalancing:ModifyListener", "elasticloadbalancing:ModifyListenerAttributes"],
      destroy: ["elasticloadbalancing:RemoveTags", "elasticloadbalancing:DeleteLoadBalancer", "elasticloadbalancing:DeleteTargetGroup", "elasticloadbalancing:DeleteListener", "elasticloadbalancing:DeleteRule"],
    },
    resources: (scope) => [
      `arn:aws:elasticloadbalancing:${scope.region}:${scope.accountId}:loadbalancer/app/${projectPrefix(scope)}/*`,
      `arn:aws:elasticloadbalancing:${scope.region}:${scope.accountId}:targetgroup/*/*`,
      `arn:aws:elasticloadbalancing:${scope.region}:${scope.accountId}:listener/app/${projectPrefix(scope)}/*/*`,
      `arn:aws:elasticloadbalancing:${scope.region}:${scope.accountId}:listener-rule/app/${projectPrefix(scope)}/*/*/*`,
    ],
    policyResources: (scope) => [
      `arn:aws:elasticloadbalancing:${scope.region}:${scope.accountId}:loadbalancer/app/dg-*/*`,
      `arn:aws:elasticloadbalancing:${scope.region}:${scope.accountId}:targetgroup/*/*`,
      `arn:aws:elasticloadbalancing:${scope.region}:${scope.accountId}:listener/app/dg-*/*/*`,
      `arn:aws:elasticloadbalancing:${scope.region}:${scope.accountId}:listener-rule/app/dg-*/*/*/*`,
    ],
    simulationResources: (scope, action) => {
      if (action === "elasticloadbalancing:AddTags" || action === "elasticloadbalancing:RemoveTags") return [
        `arn:aws:elasticloadbalancing:${scope.region}:${scope.accountId}:loadbalancer/app/${projectPrefix(scope)}/0000000000000000`,
        `arn:aws:elasticloadbalancing:${scope.region}:${scope.accountId}:targetgroup/${projectPrefix(scope)}/0000000000000000`,
        `arn:aws:elasticloadbalancing:${scope.region}:${scope.accountId}:listener/app/${projectPrefix(scope)}/0000000000000000/0000000000000000`,
      ];
      if (action.includes("TargetGroup")) return [`arn:aws:elasticloadbalancing:${scope.region}:${scope.accountId}:targetgroup/${projectPrefix(scope)}/0000000000000000`];
      if (action === "elasticloadbalancing:CreateListener") return [`arn:aws:elasticloadbalancing:${scope.region}:${scope.accountId}:loadbalancer/app/${projectPrefix(scope)}/0000000000000000`];
      if (action === "elasticloadbalancing:DeleteRule") return [`arn:aws:elasticloadbalancing:${scope.region}:${scope.accountId}:listener-rule/app/${projectPrefix(scope)}/0000000000000000/0000000000000000/0000000000000000`];
      if (action.includes("Listener")) return [`arn:aws:elasticloadbalancing:${scope.region}:${scope.accountId}:listener/app/${projectPrefix(scope)}/0000000000000000/0000000000000000`];
      return [`arn:aws:elasticloadbalancing:${scope.region}:${scope.accountId}:loadbalancer/app/${projectPrefix(scope)}/0000000000000000`];
    },
  },
  {
    id: "execution-roles",
    area: "iam",
    paths: DEPLOY_DESTROY,
    actions: ["iam:CreateRole", "iam:DeleteRole", "iam:PutRolePolicy", "iam:DeleteRolePolicy", "iam:DetachRolePolicy", "iam:DetachGroupPolicy", "iam:DetachUserPolicy", "iam:DeletePolicy", "iam:DeletePolicyVersion", "iam:RemoveRoleFromInstanceProfile", "iam:DeleteInstanceProfile", "iam:PassRole", "iam:TagRole", "iam:UntagRole"],
    actionsByPath: {
      deploy: ["iam:CreateRole", "iam:PutRolePolicy", "iam:DeleteRolePolicy", "iam:PassRole", "iam:TagRole", "iam:UntagRole"],
      destroy: ["iam:DeleteRole", "iam:DeleteRolePolicy", "iam:DetachRolePolicy", "iam:DetachGroupPolicy", "iam:DetachUserPolicy", "iam:DeletePolicy", "iam:DeletePolicyVersion", "iam:RemoveRoleFromInstanceProfile", "iam:DeleteInstanceProfile", "iam:UntagRole"],
    },
    resources: (scope) => [`arn:aws:iam::${scope.accountId}:role/${projectPrefix(scope)}*`, `arn:aws:iam::${scope.accountId}:policy/${projectPrefix(scope)}*`, `arn:aws:iam::${scope.accountId}:instance-profile/${projectPrefix(scope)}*`, `arn:aws:iam::${scope.accountId}:group/*`, `arn:aws:iam::${scope.accountId}:user/*`],
    policyResources: (scope) => [`arn:aws:iam::${scope.accountId}:role/dg-*`, `arn:aws:iam::${scope.accountId}:policy/dg-*`, `arn:aws:iam::${scope.accountId}:instance-profile/dg-*`, `arn:aws:iam::${scope.accountId}:group/*`, `arn:aws:iam::${scope.accountId}:user/*`],
    simulationResources: (scope, action) => {
      if (action === "iam:DetachGroupPolicy") return [`arn:aws:iam::${scope.accountId}:group/deployguard-simulation`, `arn:aws:iam::${scope.accountId}:policy/${projectPrefix(scope)}-simulation`];
      if (action === "iam:DetachUserPolicy") return [`arn:aws:iam::${scope.accountId}:user/deployguard-simulation`, `arn:aws:iam::${scope.accountId}:policy/${projectPrefix(scope)}-simulation`];
      return [`arn:aws:iam::${scope.accountId}:role/${projectPrefix(scope)}-simulation`, `arn:aws:iam::${scope.accountId}:policy/${projectPrefix(scope)}-simulation`, `arn:aws:iam::${scope.accountId}:instance-profile/${projectPrefix(scope)}-simulation`];
    },
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
    resources: (scope) => [`arn:aws:secretsmanager:${scope.region}:${scope.accountId}:secret:deployguard/${scope.projectId}/${scope.environmentName}/${scope.generationId}/*`],
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
    condition: (scope) => ownershipCondition(scope, "aws:ResourceTag"),
    policyCondition: () => platformOwnershipCondition("aws:ResourceTag"),
    simulationContext: (scope) => ownershipContext(scope, "aws:ResourceTag"),
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
    condition: (scope) => ownershipCondition(scope, "aws:RequestTag"),
    policyCondition: () => platformOwnershipCondition("aws:RequestTag"),
    simulationContext: (scope) => ownershipContext(scope, "aws:RequestTag"),
  },
  {
    id: "efs-children",
    area: "efs",
    paths: ["deploy"],
    actions: ["elasticfilesystem:CreateAccessPoint", "elasticfilesystem:CreateMountTarget"],
    resources: (scope) => [`arn:aws:elasticfilesystem:${scope.region}:${scope.accountId}:file-system/*`],
    condition: (scope) => ownershipCondition(scope, "aws:ResourceTag"),
    policyCondition: () => platformOwnershipCondition("aws:ResourceTag"),
    simulationContext: (scope) => ownershipContext(scope, "aws:ResourceTag"),
  },
  {
    id: "service-discovery",
    area: "service-discovery",
    paths: DEPLOY_DESTROY,
    actions: ["servicediscovery:CreatePrivateDnsNamespace", "servicediscovery:CreateService", "servicediscovery:UpdatePrivateDnsNamespace", "servicediscovery:DeleteNamespace", "servicediscovery:UpdateService", "servicediscovery:UpdateServiceAttributes", "servicediscovery:DeleteService", "servicediscovery:DeleteServiceAttributes", "servicediscovery:TagResource", "servicediscovery:UntagResource", "route53:CreateHostedZone"],
    actionsByPath: {
      deploy: ["servicediscovery:CreatePrivateDnsNamespace", "servicediscovery:CreateService", "servicediscovery:UpdatePrivateDnsNamespace", "servicediscovery:UpdateService", "servicediscovery:UpdateServiceAttributes", "servicediscovery:TagResource", "servicediscovery:UntagResource", "route53:CreateHostedZone"],
      destroy: ["servicediscovery:DeleteNamespace", "servicediscovery:DeleteService", "servicediscovery:DeleteServiceAttributes", "servicediscovery:UntagResource"],
    },
    resources: () => ["*"],
  },
  {
    id: "project-extinction-parameters",
    area: "ssm",
    paths: ["destroy"],
    actions: ["ssm:GetParametersByPath", "ssm:DeleteParameter"],
    resources: (scope) => [`arn:aws:ssm:${scope.region}:${scope.accountId}:parameter/deployguard/${scope.projectId}*`],
    policyResources: () => ["arn:aws:ssm:*:*:parameter/deployguard/*"],
  },
  {
    id: "project-extinction-backups",
    area: "backup",
    paths: ["destroy"],
    actions: ["backup:ListBackupVaults", "backup:ListRecoveryPointsByBackupVault", "backup:ListTags", "backup:DeleteRecoveryPoint", "backup:DeleteBackupVault"],
    resources: () => ["*"],
  },
  {
    id: "project-extinction-notification-topics",
    area: "sns",
    paths: ["destroy"],
    actions: ["sns:ListTagsForResource", "sns:DeleteTopic"],
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
  };
  const canonical = {
    capabilities: WORKFLOW_AWS_CAPABILITIES.map(({ id, area, actions, paths, actionsByPath }) => ({ id, area, actions: [...actions].sort(), paths: [...paths].sort(), actionsByPath })),
    policy: workflowCapabilityPolicy(fingerprintScope),
  };
  return createHash("sha256").update(`${WORKFLOW_AWS_CAPABILITY_CONTRACT_VERSION}:${JSON.stringify(canonical)}`).digest("hex");
}
