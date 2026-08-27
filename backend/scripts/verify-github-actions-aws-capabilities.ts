import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  capabilitiesFor,
  WorkflowAwsCapability,
  WorkflowAwsCapabilityScope,
  workflowCapabilityPolicy,
  workflowCapabilityRuntimeStatus,
  WORKFLOW_AWS_CAPABILITIES,
  WORKFLOW_AWS_CAPABILITY_CONTRACT_VERSION,
} from "../src/projects/github-actions-aws-capability-contract";
import {
  reconcileWorkflowCapabilities,
  WorkflowAwsCapabilityError,
} from "../src/projects/github-actions-aws-capability.service";
import {
  githubActionsExecutionStageFromLog,
  githubActionsPlatformCapabilityFailure,
} from "../src/projects/pipeline/github-actions-stage-presentation";

const root = resolve(__dirname, "../..");
const workflow = readFileSync(resolve(root, ".github/workflows/deployguard-reusable.yml"), "utf8");
const deployment = readFileSync(resolve(root, "backend/src/projects/github-actions-deployment.service.ts"), "utf8");
const health = readFileSync(resolve(root, "backend/src/health/health.service.ts"), "utf8");
const productVerifier = readFileSync(resolve(root, "scripts/verify-local-product.mjs"), "utf8");
const scope: WorkflowAwsCapabilityScope = {
  accountId: "563149050793",
  region: "us-east-1",
  projectId: "fc0d5f53-8b6d-401a-b532-966dd4f7eff8",
  environmentName: "dev",
  generationId: "f0c70050-8d95-4fa4-ba2e-49465e950a39",
  terraformStateBucket: "deployguard-terraform-state-563149050793",
  vpcId: "vpc-09a0ea2a804d00f6f",
  sharedEcsClusterArn: "arn:aws:ecs:us-east-1:563149050793:cluster/dg-shared-platform",
  sharedAlbArn: "arn:aws:elasticloadbalancing:us-east-1:563149050793:loadbalancer/app/dg-shared-platform/ef4e1a755d759649",
  sharedAlbListenerArn: "arn:aws:elasticloadbalancing:us-east-1:563149050793:listener/app/dg-shared-platform/ef4e1a755d759649/81045e4aa0523915",
};
const roleArn = `arn:aws:iam::${scope.accountId}:role/DeployGuardGithubActions`;

class FakeIam {
  puts = 0;
  deletes = 0;
  simulations: any[] = [];
  policy: unknown = null;
  legacyPolicy: unknown = null;
  allowed = new Set<string>();
  driftAfterPut = false;

  constructor(input: { policy?: unknown; legacyPolicy?: unknown; allowed?: string[]; driftAfterPut?: boolean } = {}) {
    this.policy = input.policy || null;
    this.legacyPolicy = input.legacyPolicy || null;
    for (const action of input.allowed || []) this.allowed.add(action);
    this.driftAfterPut = input.driftAfterPut === true;
  }

  async send(command: any) {
    const name = command.constructor.name;
    if (name === "GetRolePolicyCommand") {
      const policy = command.input.PolicyName === "DeployGuardDeploymentResources" ? this.legacyPolicy : this.policy;
      if (!policy) throw Object.assign(new Error("missing"), { name: "NoSuchEntityException" });
      return { PolicyDocument: encodeURIComponent(JSON.stringify(this.driftAfterPut && this.puts > 0 ? { Version: "2012-10-17", Statement: [] } : policy)) };
    }
    if (name === "DeleteRolePolicyCommand") {
      assert.equal(command.input.PolicyName, "DeployGuardDeploymentResources");
      this.deletes += 1;
      this.legacyPolicy = null;
      this.allowed.clear();
      for (const statement of (this.policy as any)?.Statement || []) {
        for (const action of Array.isArray(statement.Action) ? statement.Action : [statement.Action]) this.allowed.add(action);
      }
      return {};
    }
    if (name === "PutRolePolicyCommand") {
      this.puts += 1;
      this.policy = JSON.parse(command.input.PolicyDocument);
      for (const statement of (this.policy as any).Statement || []) {
        for (const action of Array.isArray(statement.Action) ? statement.Action : [statement.Action]) this.allowed.add(action);
      }
      return {};
    }
    if (name === "SimulatePrincipalPolicyCommand") {
      this.simulations.push(command.input);
      return {
        EvaluationResults: command.input.ActionNames.map((action: string) => ({
          EvalActionName: action,
          EvalDecision: this.allowed.has(action) ? "allowed" : "implicitDeny",
        })),
        IsTruncated: false,
      };
    }
    throw new Error(`unexpected command ${name}`);
  }
}

const actionsFor = (capabilities: readonly WorkflowAwsCapability[]) => [...new Set(capabilities.flatMap((item) => [...item.actions]))];

async function run() {
  assert.equal(WORKFLOW_AWS_CAPABILITY_CONTRACT_VERSION, "deployguard.workflow-aws/v2");
  assert.equal(workflowCapabilityRuntimeStatus().stale, false, "the verifier is executing the current source capability contract");
  assert.match(health, /workflowCapabilityRuntimeStatus\(\)/, "readiness exposes and gates on the running capability fingerprint");
  assert.match(productVerifier, /workflowCapabilityFingerprint\(\)/, "product verification compares the running fingerprint with the current build");
  assert.ok(capabilitiesFor("deploy").length > 0 && capabilitiesFor("destroy").length > 0 && capabilitiesFor("rollback").length > 0 && capabilitiesFor("promote").length > 0 && capabilitiesFor("compensate").length > 0);
  assert.deepEqual(new Set(WORKFLOW_AWS_CAPABILITIES.map((item) => item.area)), new Set(["sts", "ecr", "ecs", "ec2", "elbv2", "logs", "iam", "secrets", "efs", "service-discovery", "s3"]));
  for (const action of ["deploy", "destroy", "rollback", "promote", "compensate"] as const) {
    assert.ok(actionsFor(capabilitiesFor(action)).length > 0, `${action} has an explicit required capability set`);
  }
  const contractActions = new Set(actionsFor(WORKFLOW_AWS_CAPABILITIES));
  const servicePrefixes: Record<string, string> = { efs: "elasticfilesystem", elbv2: "elasticloadbalancing", resourcegroupstaggingapi: "tag", s3api: "s3" };
  const commandAction = (service: string, operation: string) => {
    if (service === "ecr" && operation === "get-login-password") return "ecr:GetAuthorizationToken";
    if (service === "s3api" && operation === "list-object-versions") return "s3:ListBucketVersions";
    if (service === "s3api" && operation === "delete-objects") return "s3:DeleteObjectVersion";
    return `${servicePrefixes[service] || service}:${operation.split("-").map((part) => `${part[0]?.toUpperCase() || ""}${part.slice(1)}`).join("")}`;
  };
  const explicitCommands = [...workflow.matchAll(/\baws\s+([a-z0-9-]+)\s+([a-z0-9-]+)/g)]
    .map((match) => [match[1], match[2]] as const)
    .filter(([, operation]) => operation !== "wait");
  for (const [service, operation] of explicitCommands) {
    const action = commandAction(service, operation);
    assert.ok(contractActions.has(action), `explicit workflow API ${service} ${operation} is declared as ${action}`);
  }
  for (const block of workflow.split(/\n\s{6}- name: /).slice(1)) {
    if (/\n\s+if: \$\{\{ false \}\}/.test(block)) continue;
    const calls = [...block.matchAll(/\baws\s+([a-z0-9-]+)\s+([a-z0-9-]+)/g)]
      .map((match) => commandAction(match[1], match[2]));
    if (!calls.length) continue;
    const paths = (["deploy", "destroy", "rollback", "promote", "compensate", "cleanup"] as const)
      .filter((path) => new RegExp(`deployment_action == '${path}'`).test(block));
    assert.ok(paths.length > 0, "every active workflow AWS CLI block declares its lifecycle path");
    // A shared shell block can branch on DEPLOYMENT_ACTION. Its complete CLI
    // surface must be admitted by at least one declared path; single-path
    // blocks remain exact. Retired cleanup deliberately uses Destroy's exact
    // generation scope, but it has no project-deletion workflow steps.
    const pathActions = new Set(paths.flatMap((path) => actionsFor(capabilitiesFor(path === "cleanup" ? "destroy" : path))));
    for (const action of calls) assert.ok(pathActions.has(action), `${paths.join("/")} workflow CLI call ${action} is present in its admission set`);
  }
  assert.doesNotMatch(workflow, /@aws-sdk\/client-|require\(["']@aws-sdk\/client-/, "workflow inline helpers contain no hidden AWS SDK caller");
  const providerDependencies: Record<string, readonly string[]> = {
    aws_vpc: ["ec2:DescribeVpcs", "ec2:DescribeVpcAttribute", "ec2:DescribeRouteTables"],
    aws_cloudwatch_log_group: ["logs:CreateLogGroup", "logs:DescribeLogGroups", "logs:ListTagsForResource", "logs:PutRetentionPolicy", "logs:TagResource", "logs:UntagResource", "logs:DeleteLogGroup"],
    aws_secretsmanager_secret: ["secretsmanager:CreateSecret", "secretsmanager:DescribeSecret", "secretsmanager:GetResourcePolicy", "secretsmanager:UpdateSecret", "secretsmanager:TagResource", "secretsmanager:UntagResource", "secretsmanager:DeleteSecret"],
    aws_secretsmanager_secret_version: ["secretsmanager:GetSecretValue", "secretsmanager:ListSecretVersionIds", "secretsmanager:PutSecretValue", "secretsmanager:UpdateSecretVersionStage"],
    aws_service_discovery_private_dns_namespace: ["servicediscovery:CreatePrivateDnsNamespace", "servicediscovery:GetNamespace", "servicediscovery:GetOperation", "servicediscovery:UpdatePrivateDnsNamespace", "servicediscovery:DeleteNamespace", "servicediscovery:ListTagsForResource", "servicediscovery:TagResource", "servicediscovery:UntagResource", "ec2:DescribeRegions", "ec2:DescribeVpcs", "route53:CreateHostedZone", "route53:GetHostedZone", "route53:ListHostedZonesByName"],
    aws_service_discovery_service: ["servicediscovery:CreateService", "servicediscovery:GetService", "servicediscovery:GetServiceAttributes", "servicediscovery:UpdateService", "servicediscovery:UpdateServiceAttributes", "servicediscovery:DeleteService", "servicediscovery:DeleteServiceAttributes", "servicediscovery:ListTagsForResource", "servicediscovery:TagResource", "servicediscovery:UntagResource"],
    aws_security_group: ["ec2:CreateSecurityGroup", "ec2:DescribeSecurityGroups", "ec2:DescribeSecurityGroupRules", "ec2:AuthorizeSecurityGroupIngress", "ec2:AuthorizeSecurityGroupEgress", "ec2:RevokeSecurityGroupIngress", "ec2:RevokeSecurityGroupEgress", "ec2:CreateTags", "ec2:DeleteTags", "ec2:DeleteSecurityGroup"],
    aws_efs_file_system: ["elasticfilesystem:CreateFileSystem", "elasticfilesystem:DescribeFileSystems", "elasticfilesystem:DescribeLifecycleConfiguration", "elasticfilesystem:PutLifecycleConfiguration", "elasticfilesystem:UpdateFileSystem", "elasticfilesystem:TagResource", "elasticfilesystem:UntagResource", "elasticfilesystem:DeleteFileSystem"],
    aws_efs_mount_target: ["elasticfilesystem:CreateMountTarget", "elasticfilesystem:DescribeMountTargets", "elasticfilesystem:DescribeMountTargetSecurityGroups", "ec2:DescribeNetworkInterfaces", "elasticfilesystem:DeleteMountTarget"],
    aws_efs_access_point: ["elasticfilesystem:CreateAccessPoint", "elasticfilesystem:DescribeAccessPoints", "elasticfilesystem:TagResource", "elasticfilesystem:UntagResource", "elasticfilesystem:DeleteAccessPoint"],
    aws_iam_role: ["iam:CreateRole", "iam:GetRole", "iam:ListRolePolicies", "iam:GetRolePolicy", "iam:ListAttachedRolePolicies", "iam:ListInstanceProfilesForRole", "iam:DeleteRolePolicy", "iam:DetachRolePolicy", "iam:RemoveRoleFromInstanceProfile", "iam:TagRole", "iam:UntagRole", "iam:DeleteRole"],
    aws_iam_role_policy: ["iam:GetRolePolicy", "iam:PutRolePolicy", "iam:DeleteRolePolicy"],
    aws_ecs_task_definition: ["ecs:RegisterTaskDefinition", "ecs:DescribeTaskDefinition", "ecs:ListTagsForResource"],
    aws_ecs_service: ["ecs:CreateService", "ecs:DescribeServices", "ecs:ListTasks", "ecs:ListTagsForResource", "ecs:UpdateService", "ecs:DeleteService", "ecs:TagResource", "ecs:UntagResource", "iam:PassRole"],
    aws_lb_target_group: ["elasticloadbalancing:CreateTargetGroup", "elasticloadbalancing:DescribeTargetGroups", "elasticloadbalancing:DescribeTargetGroupAttributes", "elasticloadbalancing:DescribeTags", "elasticloadbalancing:ModifyTargetGroup", "elasticloadbalancing:ModifyTargetGroupAttributes", "elasticloadbalancing:AddTags", "elasticloadbalancing:RemoveTags", "elasticloadbalancing:DeleteTargetGroup"],
    aws_lb_listener_rule: ["elasticloadbalancing:CreateRule", "elasticloadbalancing:DescribeListeners", "elasticloadbalancing:DescribeListenerAttributes", "elasticloadbalancing:DescribeRules", "elasticloadbalancing:DescribeTags", "elasticloadbalancing:ModifyRule", "elasticloadbalancing:SetRulePriorities", "elasticloadbalancing:AddTags", "elasticloadbalancing:RemoveTags", "elasticloadbalancing:DeleteRule"],
  };
  const terraformAwsTypes = [...workflow.matchAll(/\b(?:data|resource)\s+"(aws_[a-z0-9_]+)"/g)].map((match) => match[1]);
  for (const type of new Set(terraformAwsTypes)) {
    assert.ok(providerDependencies[type], `active generated Terraform type ${type} has an explicit provider dependency declaration`);
    for (const action of providerDependencies[type]) {
      assert.ok(contractActions.has(action), `provider dependency ${type} -> ${action} is declared by the canonical contract`);
    }
  }
  const admissionSource = readFileSync(resolve(root, "backend/src/projects/github-actions-aws-capability.service.ts"), "utf8");
  for (const command of ["GetRolePolicyCommand", "PutRolePolicyCommand", "DeleteRolePolicyCommand", "SimulatePrincipalPolicyCommand"]) {
    assert.match(admissionSource, new RegExp(`new ${command}\\(`), `backend IAM admission caller ${command} remains explicitly covered`);
  }
  assert.ok(contractActions.has("ecs:DescribeServices"), "ECS services-stable waiter permission is declared");
  const firstDeployProviderReads = [
    "sts:GetCallerIdentity",
    "ec2:DescribeVpcs",
    "ec2:DescribeVpcAttribute",
    "ec2:DescribeRouteTables",
    "ec2:DescribeSecurityGroups",
    "ec2:DescribeSecurityGroupRules",
    "ec2:DescribeNetworkInterfaces",
    "logs:DescribeLogGroups",
    "iam:GetRole",
    "iam:GetRolePolicy",
    "iam:ListRolePolicies",
    "iam:ListAttachedRolePolicies",
    "ecs:DescribeServices",
    "ecs:DescribeTaskDefinition",
    "ecs:DescribeTasks",
    "ecs:ListTasks",
    "ecs:ListTagsForResource",
    "elasticloadbalancing:DescribeTargetGroups",
    "elasticloadbalancing:DescribeTargetGroupAttributes",
    "elasticloadbalancing:DescribeListeners",
    "elasticloadbalancing:DescribeListenerAttributes",
    "elasticloadbalancing:DescribeRules",
    "elasticloadbalancing:DescribeTags",
    "elasticloadbalancing:DescribeTargetHealth",
    "elasticfilesystem:DescribeFileSystems",
    "elasticfilesystem:DescribeAccessPoints",
    "elasticfilesystem:DescribeMountTargets",
    "elasticfilesystem:DescribeMountTargetSecurityGroups",
    "elasticfilesystem:DescribeLifecycleConfiguration",
    "secretsmanager:DescribeSecret",
    "secretsmanager:GetResourcePolicy",
    "secretsmanager:ListSecretVersionIds",
    "servicediscovery:GetOperation",
    "servicediscovery:GetNamespace",
    "servicediscovery:GetService",
    "servicediscovery:GetServiceAttributes",
    "servicediscovery:ListTagsForResource",
  ];
  const cloudMapPrivateNamespaceDependencies = [
    "ec2:DescribeRegions",
    "ec2:DescribeVpcs",
    "route53:CreateHostedZone",
    "route53:GetHostedZone",
    "route53:ListHostedZonesByName",
  ];
  const deployActions = new Set(actionsFor(capabilitiesFor("deploy")));
  for (const action of [...firstDeployProviderReads, ...cloudMapPrivateNamespaceDependencies]) {
    assert.ok(deployActions.has(action), `first-Deploy Terraform/provider capability ${action} is admitted before dispatch`);
  }
  const rollbackActions = new Set(actionsFor(capabilitiesFor("rollback")));
  for (const action of ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "ec2:DescribeVpcAttribute", "ecs:RegisterTaskDefinition", "ecs:UpdateService", "iam:PassRole"]) {
    assert.ok(rollbackActions.has(action), `Rollback Terraform dependency ${action} is admitted`);
  }
  const promoteActions = new Set(actionsFor(capabilitiesFor("promote")));
  for (const action of ["ecs:DescribeServices", "ecs:DescribeTaskDefinition", "ecs:DescribeTasks", "ecs:ListTasks", "elasticloadbalancing:DescribeRules", "elasticloadbalancing:DescribeTags", "elasticloadbalancing:DescribeTargetHealth", "elasticloadbalancing:CreateRule", "elasticloadbalancing:ModifyRule", "elasticloadbalancing:DeleteRule"]) {
    assert.ok(promoteActions.has(action), `candidate promotion capability ${action} is admitted`);
  }
  const compensateActions = new Set(actionsFor(capabilitiesFor("compensate")));
  for (const action of ["elasticloadbalancing:DescribeRules", "elasticloadbalancing:DescribeTags", "elasticloadbalancing:ModifyRule", "elasticloadbalancing:DeleteRule"]) {
    assert.ok(compensateActions.has(action), `promotion compensation capability ${action} is admitted`);
  }
  assert.equal([...promoteActions].some((action) => action.startsWith("ecr:") || action.startsWith("s3:") || action === "ec2:DeleteVpc"), false, "promotion cannot acquire unrelated build, state or shared-network authority");
  assert.equal([...compensateActions].some((action) => action.startsWith("ecr:") || action.startsWith("s3:") || action === "ec2:DeleteVpc"), false, "compensation is limited to exact route evidence and repair");
  const cleanupStart = workflow.indexOf("- name: Clean exact generation independently");
  const cleanupEnd = workflow.indexOf("- name: Verify exact project deletion and write result");
  assert.ok(cleanupStart >= 0 && cleanupEnd > cleanupStart, "retired-generation cleanup block is present before project-deletion verification");
  const retiredCleanup = workflow.slice(cleanupStart, cleanupEnd);
  assert.match(retiredCleanup, /if: inputs\.deployment_action == 'cleanup'/, "retired-generation cleanup has an explicit independent lifecycle path");
  assert.doesNotMatch(retiredCleanup, /if: \$\{\{ false \}\}/, "retired-generation cleanup is not hard-disabled");

  const policy = workflowCapabilityPolicy(scope);
  assert.ok(Buffer.byteLength(JSON.stringify(policy)) <= 10_240, "canonical managed inline policy fits IAM's size limit");
  assert.ok(JSON.stringify(policy).includes(":task/dg-*/*"), "Destroy StopTask is scoped to DeployGuard cluster tasks");
  assert.ok(JSON.stringify(policy).includes(":listener-rule/app/dg-*/*/*/*"), "Destroy DeleteRule is scoped to DeployGuard load-balancer rules");
  const createSecurityGroup = policy.Statement.find((item) => item.Action.includes("ec2:CreateSecurityGroup"));
  assert.deepEqual(createSecurityGroup?.Resource, [
    `arn:aws:ec2:${scope.region}:${scope.accountId}:vpc/${scope.vpcId}`,
    `arn:aws:ec2:${scope.region}:${scope.accountId}:security-group/*`,
  ], "security-group creation covers AWS's VPC and new-resource authorization checks");
  assert.equal(createSecurityGroup?.Condition, undefined, "CreateSecurityGroup does not depend on provider-specific tag-on-create behavior");
  for (const forbidden of ["ec2:DeleteVpc", "ec2:DeleteSubnet", "ecs:DeleteCluster", "elasticloadbalancing:DeleteLoadBalancer", "elasticloadbalancing:DeleteListener"]) {
    assert.equal(contractActions.has(forbidden), false, `${forbidden} is outside project/generation cleanup authority`);
  }
  for (const obsolete of ["tag:GetResources", "iam:DetachGroupPolicy", "iam:DetachUserPolicy", "iam:DeletePolicy", "iam:DeletePolicyVersion", "iam:DeleteInstanceProfile"]) {
    assert.equal(contractActions.has(obsolete), false, `${obsolete} has no caller in the active workflow or generated Terraform`);
  }
  const bucket = policy.Statement.find((item) => item.Sid.includes("terraformstatebucket"));
  assert.deepEqual(bucket?.Resource, [`arn:aws:s3:::${scope.terraformStateBucket}`]);
  assert.equal(bucket?.Condition, undefined, "the state bucket is enumerated only with exact recorded object prefixes");
  const stateObjects = policy.Statement.find((item) => item.Sid.includes("terraformstateobjects"));
  assert.deepEqual(stateObjects?.Resource, [`arn:aws:s3:::${scope.terraformStateBucket}/projects/*`]);
  const efs = policy.Statement.find((item) => item.Sid.includes("efsexisting"));
  assert.equal(efs?.Condition?.StringEquals?.["aws:ResourceTag/ManagedBy"], "DeployGuard");
  assert.equal(efs?.Condition?.StringLike?.["aws:ResourceTag/DeployGuardProjectId"], "*");
  assert.equal(efs?.Condition?.StringLike?.["aws:ResourceTag/Environment"], "*");
  assert.equal(efs?.Condition?.StringEquals?.["aws:ResourceTag/DeployGuardScope"], "project");
  assert.ok(JSON.stringify(policy).includes(scope.accountId) && JSON.stringify(policy).includes(scope.region), "resource scopes bind the configured account and region");
  const anotherScope = { ...scope, projectId: "11111111-1111-4111-8111-111111111111", generationId: "22222222-2222-4222-8222-222222222222" };
  assert.deepEqual(workflowCapabilityPolicy(anotherScope), policy, "a shared platform role has one stable policy rather than a racy per-project rewrite");

  const required = actionsFor(WORKFLOW_AWS_CAPABILITIES);
  const previousRole = new FakeIam({ legacyPolicy: { Version: "2012-10-17", Statement: [] }, allowed: required.filter((action) => action !== "elasticloadbalancing:DescribeTags") });
  const reconciled = await reconcileWorkflowCapabilities({ client: previousRole, roleArn, roleName: "DeployGuardGithubActions", scope, action: "destroy", platformManaged: true });
  assert.equal(reconciled.reconciled, true, "an obsolete platform-managed role is reconciled before use");
  assert.equal(previousRole.puts, 1);
  assert.equal(previousRole.deletes, 1, "the obsolete aggregate-quota-consuming inline policy is retired before canonical reconciliation");
  assert.ok(previousRole.simulations.length > 0, "effective permission simulation verifies action, resource and condition context");
  const efsSimulation = previousRole.simulations.find((item) => item.ActionNames.includes("elasticfilesystem:DeleteFileSystem"));
  assert.equal(efsSimulation.ContextEntries.find((item: any) => item.ContextKeyName === "aws:ResourceTag/DeployGuardScope")?.ContextKeyValues[0], "project", "the effective gate probes the project-persistence scope");
  const stateSimulation = previousRole.simulations.find((item) => item.ActionNames.includes("s3:GetObject"));
  assert.ok(stateSimulation.ResourceArns[0].includes(`/${scope.projectId}/${scope.environmentName}/${scope.generationId}/`), "the effective gate probes the exact generation state key");
  const currentRole = new FakeIam({ policy, allowed: required });
  const current = await reconcileWorkflowCapabilities({ client: currentRole, roleArn, roleName: "DeployGuardGithubActions", scope, action: "deploy", platformManaged: true });
  assert.equal(current.reconciled, false, "a current managed role receives no IAM write");
  assert.equal(currentRole.puts, 0);
  const securityGroupSimulation = currentRole.simulations.find((item) => item.ActionNames.includes("ec2:CreateSecurityGroup"));
  assert.deepEqual(securityGroupSimulation.ResourceArns, [
    `arn:aws:ec2:${scope.region}:${scope.accountId}:vpc/${scope.vpcId}`,
    "arn:aws:ec2:us-east-1:563149050793:security-group/deployguard-simulation",
  ], "effective simulation checks both resources required by CreateSecurityGroup");
  const createRuleSimulation = currentRole.simulations.find((item) => item.ActionNames.includes("elasticloadbalancing:CreateRule"));
  assert.equal(createRuleSimulation.ResourceArns[0], scope.sharedAlbListenerArn, "CreateRule is simulated against the actual shared listener ARN");
  const modifyRuleSimulation = currentRole.simulations.find((item) => item.ActionNames.includes("elasticloadbalancing:ModifyRule"));
  assert.match(modifyRuleSimulation.ResourceArns[0], /:listener-rule\/app\/dg-shared-platform\/ef4e1a755d759649\/81045e4aa0523915\//, "ModifyRule is simulated against a deterministic rule under the actual shared listener");
  const prioritiesSimulation = currentRole.simulations.find((item) => item.ActionNames.includes("elasticloadbalancing:SetRulePriorities"));
  assert.match(prioritiesSimulation.ResourceArns[0], /:listener-rule\/app\//, "SetRulePriorities is simulated against a listener-rule ARN");

  const external = new FakeIam({ allowed: required.filter((action) => action !== "ecs:UpdateService") });
  await assert.rejects(
    reconcileWorkflowCapabilities({ client: external, roleArn, roleName: "ExternalRole", scope, action: "rollback", platformManaged: false }),
    (error: unknown) => error instanceof WorkflowAwsCapabilityError && error.missingCapabilities.includes("ecs:UpdateService"),
  );
  assert.equal(external.puts, 0, "an external role is never mutated");

  const futureCapability: WorkflowAwsCapability = {
    id: "future-read-api",
    area: "sts",
    paths: ["destroy"],
    actions: ["tag:GetResources"],
    resources: () => ["*"],
  };
  const oldRole = new FakeIam({ allowed: actionsFor(capabilitiesFor("destroy")) });
  const driftResult = await reconcileWorkflowCapabilities({
    client: oldRole,
    roleArn,
    roleName: "DeployGuardGithubActions",
    scope,
    action: "destroy",
    platformManaged: true,
    capabilities: [...capabilitiesFor("destroy"), futureCapability],
  });
  assert.equal(driftResult.reconciled, true);
  assert.ok(oldRole.allowed.has("tag:GetResources"), "a future workflow capability cannot bypass managed-role reconciliation");

  const driftingRole = new FakeIam({ policy: { Version: "2012-10-17", Statement: [] }, allowed: required, driftAfterPut: true });
  await assert.rejects(
    reconcileWorkflowCapabilities({ client: driftingRole, roleArn, roleName: "DeployGuardGithubActions", scope, action: "deploy", platformManaged: true }),
    (error: unknown) => error instanceof WorkflowAwsCapabilityError && error.missingCapabilities.includes("iam:GetRolePolicy"),
    "dispatch admission fails if IAM read-back differs from the canonical policy just written",
  );

  assert.doesNotMatch(workflow, /resourcegroupstaggingapi get-resources|terraform import/);
  assert.match(workflow, /Destroy other recorded generations exactly/);
  const owned = { ManagedBy: "DeployGuard", DeployGuardProjectId: scope.projectId, Environment: scope.environmentName, DeployGuardGenerationId: scope.generationId, DeployGuardResource: "app-target-group" };
  const ownsTarget = (tags: typeof owned) => tags.ManagedBy === "DeployGuard" && tags.DeployGuardProjectId === scope.projectId && tags.Environment === scope.environmentName && tags.DeployGuardGenerationId === scope.generationId && tags.DeployGuardResource === "app-target-group";
  assert.equal(ownsTarget(owned), true);
  assert.equal(ownsTarget({ ...owned, DeployGuardGenerationId: "33333333-3333-4333-8333-333333333333" }), false, "foreign-generation target groups remain rejected");

  const dispatchBody = deployment.slice(deployment.indexOf("private async dispatch"), deployment.indexOf("private retryBuildPlan"));
  assert.ok(dispatchBody.indexOf("this.awsCapabilities.ensure") < dispatchBody.indexOf("this.githubApp.ensureWorkflow"), "capability reconciliation precedes caller generation");
  assert.ok(dispatchBody.indexOf("this.awsCapabilities.ensure") < dispatchBody.indexOf("const attempt = await this.nextAttempt"), "capability reconciliation precedes attempt allocation");
  assert.ok(dispatchBody.indexOf("this.awsCapabilities.ensure") < dispatchBody.indexOf("runRepository.save(runRepository.create"), "capability reconciliation precedes attempt persistence");
  const retryBody = deployment.slice(deployment.indexOf("private async redispatch"), deployment.indexOf("private async scheduleNewOperation"));
  assert.ok(retryBody.indexOf("this.awsCapabilities.ensure") < retryBody.indexOf("runRepository.save(runRepository.create"), "Destroy retry capability preparation precedes its immutable attempt");
  const promotionBody = deployment.slice(deployment.indexOf("private async beginPromotion"), deployment.indexOf("private async beginCompensation"));
  assert.ok(promotionBody.indexOf('action: "promote"') < promotionBody.indexOf("promotionState: \"route_change_pending\""), "promotion capability admission precedes route-change dispatch state");
  const compensationBody = deployment.slice(deployment.indexOf("private async beginCompensation"), deployment.indexOf("private async finishCompensation"));
  assert.ok(compensationBody.indexOf('action: "compensate"') < compensationBody.indexOf("promotionState: \"compensation_pending\""), "compensation capability admission precedes compensation dispatch state");
  assert.match(deployment, /failCandidateBeforeDispatch\(user, project, runRepository, generation\.id, error/, "pre-dispatch capability failures terminalize the exact candidate generation instead of leaving it active");

  console.log("GitHub Actions AWS capability contract checks passed: generation/project cleanup authority excludes shared platform deletion, the contract remains versioned, and capability reconciliation precedes attempt persistence.");
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
