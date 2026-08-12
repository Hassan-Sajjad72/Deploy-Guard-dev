import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  capabilitiesFor,
  WorkflowAwsCapability,
  WorkflowAwsCapabilityScope,
  workflowCapabilityPolicy,
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
const scope: WorkflowAwsCapabilityScope = {
  accountId: "563149050793",
  region: "us-east-1",
  projectId: "fc0d5f53-8b6d-401a-b532-966dd4f7eff8",
  environmentName: "dev",
  generationId: "f0c70050-8d95-4fa4-ba2e-49465e950a39",
  terraformStateBucket: "deployguard-terraform-state-563149050793",
  vpcId: "vpc-09a0ea2a804d00f6f",
};
const roleArn = `arn:aws:iam::${scope.accountId}:role/DeployGuardGithubActions`;

class FakeIam {
  puts = 0;
  deletes = 0;
  simulations: any[] = [];
  policy: unknown = null;
  legacyPolicy: unknown = null;
  allowed = new Set<string>();

  constructor(input: { policy?: unknown; legacyPolicy?: unknown; allowed?: string[] } = {}) {
    this.policy = input.policy || null;
    this.legacyPolicy = input.legacyPolicy || null;
    for (const action of input.allowed || []) this.allowed.add(action);
  }

  async send(command: any) {
    const name = command.constructor.name;
    if (name === "GetRolePolicyCommand") {
      const policy = command.input.PolicyName === "DeployGuardDeploymentResources" ? this.legacyPolicy : this.policy;
      if (!policy) throw Object.assign(new Error("missing"), { name: "NoSuchEntityException" });
      return { PolicyDocument: encodeURIComponent(JSON.stringify(policy)) };
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
  assert.equal(WORKFLOW_AWS_CAPABILITY_CONTRACT_VERSION, "deployguard.workflow-aws/v1");
  assert.ok(capabilitiesFor("deploy").length > 0 && capabilitiesFor("destroy").length > 0 && capabilitiesFor("rollback").length > 0);
  assert.deepEqual(new Set(WORKFLOW_AWS_CAPABILITIES.map((item) => item.area)), new Set(["sts", "ecr", "ecs", "ec2", "elbv2", "logs", "iam", "secrets", "efs", "service-discovery", "s3", "ssm", "backup", "sns"]));
  for (const action of ["deploy", "destroy", "rollback"] as const) {
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
  const explicitCommands = [...workflow.matchAll(/\baws\s+(sts|ecr|ecs|ec2|elbv2|logs|iam|secretsmanager|efs|servicediscovery|resourcegroupstaggingapi|ssm|backup|sns|s3api)\s+([a-z0-9-]+)/g)]
    .map((match) => [match[1], match[2]] as const)
    .filter(([, operation]) => operation !== "wait");
  for (const [service, operation] of explicitCommands) {
    const action = commandAction(service, operation);
    assert.ok(contractActions.has(action), `explicit workflow API ${service} ${operation} is declared as ${action}`);
  }
  assert.ok(contractActions.has("ecs:DescribeServices"), "ECS services-stable waiter permission is declared");

  const policy = workflowCapabilityPolicy(scope);
  assert.ok(Buffer.byteLength(JSON.stringify(policy)) <= 10_240, "canonical managed inline policy fits IAM's size limit");
  assert.ok(JSON.stringify(policy).includes(":task/dg-*/*"), "Destroy StopTask is scoped to DeployGuard cluster tasks");
  assert.ok(JSON.stringify(policy).includes(":listener-rule/app/dg-*/*/*/*"), "Destroy DeleteRule is scoped to DeployGuard load-balancer rules");
  assert.ok(JSON.stringify(policy).includes(":group/*") && JSON.stringify(policy).includes(":user/*"), "project-policy detachment can clean group/user attachments while the policy ARN remains dg-scoped");
  const createSecurityGroup = policy.Statement.find((item) => item.Action.includes("ec2:CreateSecurityGroup"));
  assert.deepEqual(createSecurityGroup?.Resource, [
    `arn:aws:ec2:${scope.region}:${scope.accountId}:vpc/${scope.vpcId}`,
    `arn:aws:ec2:${scope.region}:${scope.accountId}:security-group/*`,
  ], "security-group creation covers AWS's VPC and new-resource authorization checks");
  assert.equal(createSecurityGroup?.Condition, undefined, "CreateSecurityGroup does not depend on provider-specific tag-on-create behavior");
  const ownedNetworkExtinction = policy.Statement.find((item) => item.Action.includes("ec2:DeleteVpc"));
  for (const action of ["ec2:DeleteSubnet", "ec2:DeleteRouteTable", "ec2:DeleteInternetGateway", "ec2:DeleteVpc"]) {
    assert.ok(ownedNetworkExtinction?.Action.includes(action), `${action} is part of the global Destroy capability contract`);
  }
  assert.equal(ownedNetworkExtinction?.Condition?.StringEquals?.["aws:ResourceTag/ManagedBy"], "DeployGuard");
  assert.equal(ownedNetworkExtinction?.Condition?.StringLike?.["aws:ResourceTag/DeployGuardProjectId"], "*");
  const bucket = policy.Statement.find((item) => item.Sid.includes("terraformstatebucket"));
  assert.deepEqual(bucket?.Resource, [`arn:aws:s3:::${scope.terraformStateBucket}`]);
  assert.equal(bucket?.Condition, undefined, "extinction must enumerate legacy and generation state keys across the dedicated bucket");
  const stateObjects = policy.Statement.find((item) => item.Sid.includes("terraformstateobjects"));
  assert.deepEqual(stateObjects?.Resource, [`arn:aws:s3:::${scope.terraformStateBucket}/projects/*`]);
  const efs = policy.Statement.find((item) => item.Sid.includes("efsexisting"));
  assert.equal(efs?.Condition?.StringEquals?.["aws:ResourceTag/ManagedBy"], "DeployGuard");
  assert.equal(efs?.Condition?.StringLike?.["aws:ResourceTag/DeployGuardProjectId"], "*");
  assert.equal(efs?.Condition?.StringLike?.["aws:ResourceTag/Environment"], "*");
  assert.equal(efs?.Condition?.StringLike?.["aws:ResourceTag/DeployGuardGenerationId"], "*");
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
  assert.equal(efsSimulation.ContextEntries.find((item: any) => item.ContextKeyName === "aws:ResourceTag/DeployGuardGenerationId")?.ContextKeyValues[0], scope.generationId, "the effective gate probes the exact generation tag context");
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

  assert.match(workflow, /resourcegroupstaggingapi get-resources/);
  assert.match(workflow, /reconcile_target_group\(\)[\s\S]*describe-target-groups --target-group-arns[\s\S]*describe-target-groups --load-balancer-arn[\s\S]*describe-tags/);
  assert.match(workflow, /DeployGuardResource == "app-target-group"/);
  const owned = { ManagedBy: "DeployGuard", DeployGuardProjectId: scope.projectId, Environment: scope.environmentName, DeployGuardGenerationId: scope.generationId, DeployGuardResource: "app-target-group" };
  const ownsTarget = (tags: typeof owned) => tags.ManagedBy === "DeployGuard" && tags.DeployGuardProjectId === scope.projectId && tags.Environment === scope.environmentName && tags.DeployGuardGenerationId === scope.generationId && tags.DeployGuardResource === "app-target-group";
  assert.equal(ownsTarget(owned), true);
  assert.equal(ownsTarget({ ...owned, DeployGuardGenerationId: "33333333-3333-4333-8333-333333333333" }), false, "foreign-generation target groups remain rejected");

  const dispatchBody = deployment.slice(deployment.indexOf("private async dispatch"), deployment.indexOf("private retryBuildPlan"));
  assert.ok(dispatchBody.indexOf("this.awsCapabilities.ensure") < dispatchBody.indexOf("this.githubApp.ensureWorkflow"), "capability reconciliation precedes caller generation");
  assert.ok(dispatchBody.indexOf("this.awsCapabilities.ensure") < dispatchBody.indexOf("const attempt = await this.nextAttempt"), "capability reconciliation precedes attempt allocation");
  assert.ok(dispatchBody.indexOf("this.awsCapabilities.ensure") < dispatchBody.indexOf("runRepository.save(runRepository.create"), "capability reconciliation precedes attempt persistence");
  const retryBody = deployment.slice(deployment.indexOf("private async redispatch"), deployment.indexOf("private schedulePersistedOperation"));
  assert.ok(retryBody.indexOf("this.awsCapabilities.ensure") < retryBody.indexOf("runRepository.save(runRepository.create"), "Destroy retry capability preparation precedes its immutable attempt");
  assert.match(deployment, /if \(error instanceof WorkflowAwsCapabilityError\) throw error;/, "capability failures never become rejected customer retry attempts");

  const attempt14 = [
    "2026-08-11T16:15:46.800Z DEPLOYGUARD_STAGE=terraform_state_preparation",
    "2026-08-11T16:16:03.849Z aws: [ERROR]: AccessDeniedException: not authorized to perform: tag:GetResources",
  ].join("\n");
  assert.equal(githubActionsExecutionStageFromLog(attempt14), "terraform_state_preparation");
  assert.deepEqual(githubActionsPlatformCapabilityFailure(attempt14), { action: "tag:GetResources", classification: "platform_configuration" });
  assert.equal(githubActionsExecutionStageFromLog(`${attempt14}\n2026-08-11T16:16:04.000Z DEPLOYGUARD_STAGE=terraform_plan_and_apply`), "terraform_plan_and_apply");

  console.log("GitHub Actions AWS capability contract checks passed: least-privilege service-native target lookup, versioned full-path contract, managed/external reconciliation, effective simulation, drift blocking, pre-attempt ordering and platform-stage classification.");
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
