import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  expectedProjectLogGroups,
  ProjectLogGroupDescription,
  ProjectLogGroupLifecyclePort,
  ProjectLogGroupLifecycleReconciler,
} from "../src/infrastructure/cloudwatch-log-lifecycle.service";
import { deploymentContractFingerprint } from "../src/projects/analysis-fingerprint";

const firstProject = "11111111-2222-4333-8444-555555555555";
const secondProject = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const group = (name: string, purpose: "app" | "database" | "deployment", projectId = firstProject): ProjectLogGroupDescription => ({
  arn: `arn:aws:logs:us-east-1:123456789012:log-group:${name}`,
  name,
  retentionInDays: 14,
  tags: { ManagedBy: "DeployGuard", DeployGuardProjectId: projectId, Environment: "dev", LogPurpose: purpose },
});

class FakePort implements ProjectLogGroupLifecyclePort {
  imports: Array<{ address: string; name: string }> = [];
  constructor(readonly groups: Map<string, ProjectLogGroupDescription[]>, readonly state = new Set<string>()) {}
  async findExact(name: string) { return this.groups.get(name) || []; }
  async stateAddresses() { return new Set(this.state); }
  async importResource(address: string, name: string) { this.imports.push({ address, name }); this.state.add(address); }
}

async function main() {
  const withoutDatabase = expectedProjectLogGroups({ project_id: firstProject, environment_name: "dev", database_service: { enabled: false } });
  assert.deepEqual(withoutDatabase.map((item) => item.purpose), ["app", "deployment"]);
  const expected = expectedProjectLogGroups({ project_id: firstProject, environment_name: "dev", database_service: { enabled: true } });
  assert.deepEqual(expected.map((item) => item.name), [
    `/deployguard/${firstProject}/dev/app`,
    `/deployguard/${firstProject}/dev/deployment`,
    `/deployguard/${firstProject}/dev/database`,
  ]);
  assert.ok(expected.every((item) => item.retentionInDays === 14));
  assert.ok(expected.every((item) => new Set(expected.map((candidate) => candidate.name)).size === expected.length));

  const missingPort = new FakePort(new Map());
  const missing = await new ProjectLogGroupLifecycleReconciler(missingPort).reconcile(expected);
  assert.ok(missing.every((item) => item.status === "missing" && item.importResult === "not_required"));
  assert.equal(missingPort.imports.length, 0, "new projects leave log-group creation to Terraform");

  const app = expected[0];
  const activePort = new FakePort(new Map([[app.name, [group(app.name, "app")]]]));
  const active = await new ProjectLogGroupLifecycleReconciler(activePort).reconcile([app]);
  assert.equal(active[0].importResult, "imported");
  assert.deepEqual(activePort.imports, [{ address: app.resourceAddress, name: app.name }]);
  const adopted = await new ProjectLogGroupLifecycleReconciler(activePort).reconcile([app]);
  assert.equal(adopted[0].importResult, "not_required", "adopted Terraform state must be a no-op");
  assert.equal(activePort.imports.length, 1);

  const wrong = group(app.name, "app");
  wrong.tags.DeployGuardProjectId = secondProject;
  const wrongReconciler = new ProjectLogGroupLifecycleReconciler(new FakePort(new Map([[app.name, [wrong]]])));
  await assert.rejects(wrongReconciler.reconcile([app]), /ownership verification/);
  const untagged = group(app.name, "app");
  untagged.tags = {};
  const untaggedReconciler = new ProjectLogGroupLifecycleReconciler(new FakePort(new Map([[app.name, [untagged]]])));
  await assert.rejects(untaggedReconciler.reconcile([app]), /ownership verification/);
  const duplicateReconciler = new ProjectLogGroupLifecycleReconciler(new FakePort(new Map([
    [app.name, [group(app.name, "app"), group(app.name, "app")]],
  ])));
  await assert.rejects(duplicateReconciler.reconcile([app]), /ambiguous/);

  const production = expectedProjectLogGroups({ project_id: secondProject, environment_name: "production", database_service: { enabled: true } });
  assert.ok(production.every((item) => item.name.startsWith(`/deployguard/${secondProject}/production/`)));
  assert.ok(production.every((item) => !item.name.includes(firstProject)));
  const contractShape = { branch: "main", ecsPlan: { logGroups: { app: `/deployguard/${firstProject}/app`, database: `/deployguard/${firstProject}/database`, deployment: `/deployguard/${firstProject}/deployment` } } };
  assert.notEqual(
    deploymentContractFingerprint(contractShape),
    deploymentContractFingerprint({ ...contractShape, ecsPlan: { logGroups: { ...contractShape.ecsPlan.logGroups, app: `/deployguard/${secondProject}/app` } } }),
    "log-group identifiers must be immutable deployment-contract evidence",
  );

  const root = join(process.cwd(), "..");
  const workflow = await readFile(join(root, ".github/workflows/deployguard-reusable.yml"), "utf8");
  const appTerraform = await readFile(join(root, "backend/terraform/modules/ecs-service/main.tf"), "utf8");
  const databaseTerraform = await readFile(join(root, "backend/terraform/modules/database-service/main.tf"), "utf8");
  const policy = await readFile(join(root, "backend/terraform/github-actions-log-access/main.tf"), "utf8");
  const contract = await readFile(join(root, "backend/src/projects/deployment-contract.service.ts"), "utf8");
  for (const purpose of ["app", "database", "deployment"]) {
    assert.match(workflow, new RegExp(`aws_cloudwatch_log_group" "${purpose}`));
    assert.match(workflow, new RegExp(`LogPurpose = "${purpose}"`));
    assert.match(contract, new RegExp(`${purpose}: .*/${purpose}`));
  }
  assert.match(workflow, /logDriver\s*=\s*"awslogs"/);
  assert.match(workflow, /reconcile_log_group app/);
  assert.match(workflow, /failed DeployGuard ownership verification/);
  assert.match(appTerraform, /retention_in_days = 14/);
  assert.match(appTerraform, /aws_cloudwatch_log_group" "deployment/);
  assert.match(databaseTerraform, /LogPurpose\s+= "database"/);
  assert.doesNotMatch(`${workflow}\n${appTerraform}\n${databaseTerraform}\n${policy}`, /["']logs:\*["']/);

  const actions = [...policy.matchAll(/"(logs:[A-Za-z]+)"/g)].map((match) => match[1]);
  for (const required of ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents", "logs:DescribeLogStreams"]) assert.ok(actions.includes(required), required);
  for (const action of actions) assert.ok([
    "logs:CreateLogGroup", "logs:DeleteLogGroup", "logs:ListTagsForResource", "logs:PutRetentionPolicy", "logs:TagResource",
    "logs:CreateLogStream", "logs:DescribeLogGroups", "logs:DescribeLogStreams", "logs:PutLogEvents",
  ].includes(action), `unexpected CloudWatch permission ${action}`);
  assert.match(policy, /actions\s+= \["logs:DescribeLogGroups"\][\s\S]*?resources\s+= \["\*"\]/);
  const allowedResourceStarStatements = [
    "ReadLogGroupInventoryForTerraform",
    "ReadTargetHealthForRollbackVerification",
    "ListTasksForDestroyVerification",
    "CreateTaggedDeployGuardSecrets",
    "DescribeDeployGuardDatabaseStorage",
    "CreateTaggedDeployGuardDatabaseStorage",
  ];
  assert.equal((policy.match(/resources\s+= \["\*"\]/g) || []).length, allowedResourceStarStatements.length, "only explicitly reviewed unscopable inventory/create statements may use Resource star");
  for (const sid of allowedResourceStarStatements) {
    assert.match(policy, new RegExp(`sid\\s+= "${sid}"[\\s\\S]*?resources\\s+= \\["\\*"\\]`));
  }
  assert.match(policy, /arn:aws:logs:\$\{var\.aws_region\}:\$\{var\.aws_account_id\}:log-group:\/deployguard\/\*/);
  assert.match(policy, /actions\s+= \["ec2:CreateTags"\]/);
  assert.match(policy, /arn:aws:ec2:\$\{var\.aws_region\}:\$\{var\.aws_account_id\}:security-group\/\*/);
  assert.match(policy, /variable = "ec2:CreateAction"[\s\S]*?values\s+= \["CreateSecurityGroup"\]/);
  assert.match(policy, /variable = "aws:RequestTag\/ManagedBy"[\s\S]*?values\s+= \["DeployGuard"\]/);
  assert.match(policy, /variable = "aws:RequestTag\/Environment"[\s\S]*?values\s+= \["dev", "production"\]/);
  assert.match(policy, /variable = "aws:RequestTag\/DeployGuardProjectId"[\s\S]*?values\s+= \["false"\]/);
  assert.doesNotMatch(policy, /ec2:\*/);
  const boundedArn = `arn:aws:logs:us-east-1:123456789012:log-group:/deployguard/${secondProject}/app`;
  assert.match(boundedArn, /^arn:aws:logs:us-east-1:123456789012:log-group:\/deployguard\/[0-9a-f-]{36}\/(?:app|database|deployment)$/);
  assert.doesNotMatch(`arn:aws:logs:us-east-1:123456789012:log-group:/unrelated/${secondProject}/app`, /log-group:\/deployguard\//);

  console.log("Project-scoped CloudWatch checks passed: naming, ownership adoption, retention, namespace isolation, awslogs and bounded IAM.");
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : "CloudWatch verification failed.");
  process.exitCode = 1;
});
