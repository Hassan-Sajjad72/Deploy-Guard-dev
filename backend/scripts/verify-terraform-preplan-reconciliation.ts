import { strict as assert } from "node:assert";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigService } from "@nestjs/config";
import { extractGithubActionsTerraformPlanSummary } from "../src/projects/github-actions-terraform-plan-evidence";
import { reviewGithubActionsTerraformPlan } from "../src/projects/github-actions-terraform-plan-policy";
import {
  expectedPersistentResources,
  PersistentResourceDescription,
  PersistentResourceExpectation,
  PersistentResourceLifecyclePort,
  PersistentResourceLifecycleReconciler,
} from "../src/infrastructure/persistent-resource-lifecycle.service";
import { TerraformRunnerService } from "../src/infrastructure/terraform-runner.service";

const projectId = "11111111-2222-4333-8444-555555555555";
const otherProject = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const generationId = "11111111-1111-4111-8111-111111111111";
const scope = { projectId, environment: "dev" as const, infrastructureNamespace: `/deployguard/${projectId}` };
const change = (address: string, type: string, actions: string[], after: Record<string, unknown> = {}, before: Record<string, unknown> | null = null) => ({ address, type, change: { actions, before, after } });
const tags = { ManagedBy: "DeployGuard", DeployGuardProjectId: projectId, Environment: "dev", DeployGuardGenerationId: generationId };
const plan = (resource_changes: unknown[]) => JSON.stringify({ resource_changes });

async function main() {
const first = reviewGithubActionsTerraformPlan(plan([
  change("aws_ecs_service.app", "aws_ecs_service", ["create"], { tags }),
  change("aws_cloudwatch_log_group.app", "aws_cloudwatch_log_group", ["create"], { name: `${scope.infrastructureNamespace}/app`, tags }),
]), scope);
assert.equal(first.safe, true);
assert.deepEqual(first.summary, { create: 2, update: 0, replace: 0, delete: 0, noOp: 0, resourceTypes: ["aws_cloudwatch_log_group", "aws_ecs_service"] });

const repeated = reviewGithubActionsTerraformPlan(plan([]), scope);
assert.equal(repeated.safe, true);
assert.deepEqual(repeated.summary, { create: 0, update: 0, replace: 0, delete: 0, noOp: 0, resourceTypes: [] });
const redeploy = reviewGithubActionsTerraformPlan(plan([
  change("aws_ecs_task_definition.app", "aws_ecs_task_definition", ["delete", "create"], { tags }, { tags }),
  change("aws_ecs_service.app", "aws_ecs_service", ["update"], { tags }, { tags }),
]), scope);
assert.equal(redeploy.safe, true, "an immutable application revision and service update are expected redeploy changes");
const afterDestroy = reviewGithubActionsTerraformPlan(plan([change("aws_ecs_service.app", "aws_ecs_service", ["create"], { tags })]), scope);
assert.equal(afterDestroy.safe, true, "redeploy after a completed destroy may create absent non-retained resources");

for (const unsafe of [
  change("module.database_service.aws_secretsmanager_secret.password[0]", "aws_secretsmanager_secret", ["delete", "create"], { tags }, { tags }),
  change("module.database_service.aws_secretsmanager_secret_version.password[0]", "aws_secretsmanager_secret_version", ["delete", "create"], { tags }, { tags }),
  change("module.database_service.aws_efs_file_system.database[0]", "aws_efs_file_system", ["delete"], {}, { tags }),
  change("aws_cloudwatch_log_group.app", "aws_cloudwatch_log_group", ["delete", "create"], { name: `${scope.infrastructureNamespace}/app`, tags }, { name: `${scope.infrastructureNamespace}/app`, tags }),
]) assert.equal(reviewGithubActionsTerraformPlan(plan([unsafe]), scope).safe, false);
assert.equal(reviewGithubActionsTerraformPlan(plan([
  change("aws_ecs_service.other", "aws_ecs_service", ["create"], { tags: { ...tags, DeployGuardProjectId: otherProject } }),
]), scope).violations[0].code, "ownership_scope_mismatch");
assert.equal(reviewGithubActionsTerraformPlan(plan([
  change("aws_cloudwatch_log_group.other", "aws_cloudwatch_log_group", ["create"], { name: `/deployguard/${otherProject}/app`, tags }),
]), scope).violations[0].code, "cross_project_namespace");
const secretNoOp = reviewGithubActionsTerraformPlan(plan([
  change("module.database_service.aws_secretsmanager_secret_version.password[0]", "aws_secretsmanager_secret_version", ["no-op"], { tags }, { tags }),
]), scope);
assert.equal(secretNoOp.safe, true, "an imported AWSCURRENT version must remain a no-op");

type RetainedEfsFixture = {
  fileSystems: Array<{ id: string; creationToken: string; encrypted: boolean; state: string; lifecycle: string; tags: Record<string, string> }>;
  accessPoints: Array<{ id: string; fileSystemId: string; uid: number; gid: number; path: string; ownerUid: number; ownerGid: number; permissions: string; tags: Record<string, string> }>;
  state: Set<string>;
};
const reconcileRetainedEfsFixture = (fixture: RetainedEfsFixture) => {
  const token = `deployguard-${projectId}-dev-database`;
  const fileSystems = fixture.fileSystems.filter((item) => item.creationToken === token);
  if (fileSystems.length !== 1) throw new Error(fileSystems.length ? "ambiguous filesystem" : "filesystem not found");
  const fileSystem = fileSystems[0];
  if (fileSystem.encrypted !== true || fileSystem.state !== "available" || fileSystem.lifecycle !== "AFTER_30_DAYS"
    || fileSystem.tags.ManagedBy !== "DeployGuard" || fileSystem.tags.DeployGuardProjectId !== projectId
    || fileSystem.tags.Environment !== "dev" || fileSystem.tags.Persistence !== "retained") throw new Error("filesystem ownership mismatch");
  const accessPoints = fixture.accessPoints.filter((item) => item.fileSystemId === fileSystem.id
    && item.tags.ManagedBy === "DeployGuard" && item.tags.DeployGuardProjectId === projectId
    && item.tags.Environment === "dev" && item.tags.Persistence === "retained");
  if (accessPoints.length !== 1) throw new Error(accessPoints.length ? "ambiguous access point" : "access point not found");
  const accessPoint = accessPoints[0];
  if (accessPoint.uid !== 999 || accessPoint.gid !== 999 || accessPoint.path !== "/database"
    || accessPoint.ownerUid !== 999 || accessPoint.ownerGid !== 999 || accessPoint.permissions !== "700") throw new Error("incompatible access point");
  const imports = [
    ["aws_efs_file_system.database[0]", fileSystem.id],
    ["aws_efs_access_point.database[0]", accessPoint.id],
  ].filter(([address]) => !fixture.state.has(address));
  imports.forEach(([address]) => fixture.state.add(address));
  return imports;
};
const retainedEfsFixture: RetainedEfsFixture = {
  fileSystems: [{ id: "fs-0123456789abcdef0", creationToken: `deployguard-${projectId}-dev-database`, encrypted: true, state: "available", lifecycle: "AFTER_30_DAYS", tags: { ...tags, Persistence: "retained" } }],
  accessPoints: [{ id: "fsap-0123456789abcdef0", fileSystemId: "fs-0123456789abcdef0", uid: 999, gid: 999, path: "/database", ownerUid: 999, ownerGid: 999, permissions: "700", tags: { ...tags, Persistence: "retained" } }],
  state: new Set(),
};
assert.deepEqual(reconcileRetainedEfsFixture(retainedEfsFixture), [
  ["aws_efs_file_system.database[0]", "fs-0123456789abcdef0"],
  ["aws_efs_access_point.database[0]", "fsap-0123456789abcdef0"],
]);
assert.deepEqual(reconcileRetainedEfsFixture(retainedEfsFixture), [], "already imported retained EFS is an idempotent no-op");
assert.throws(() => reconcileRetainedEfsFixture({ ...retainedEfsFixture, state: new Set(), fileSystems: [] }), /filesystem not found/);
assert.throws(() => reconcileRetainedEfsFixture({ ...retainedEfsFixture, state: new Set(), fileSystems: [{ ...retainedEfsFixture.fileSystems[0], tags: { ...tags, Persistence: "retained", DeployGuardProjectId: otherProject } }] }), /ownership mismatch/);
assert.throws(() => reconcileRetainedEfsFixture({ ...retainedEfsFixture, state: new Set(), fileSystems: [...retainedEfsFixture.fileSystems, { ...retainedEfsFixture.fileSystems[0], id: "fs-duplicate" }] }), /ambiguous filesystem/);
assert.throws(() => reconcileRetainedEfsFixture({ ...retainedEfsFixture, state: new Set(), accessPoints: [...retainedEfsFixture.accessPoints, { ...retainedEfsFixture.accessPoints[0], id: "fsap-duplicate" }] }), /ambiguous access point/);
assert.throws(() => reconcileRetainedEfsFixture({ ...retainedEfsFixture, state: new Set(), accessPoints: [{ ...retainedEfsFixture.accessPoints[0], path: "/wrong" }] }), /incompatible access point/);
const adoptedEfsPlan = reviewGithubActionsTerraformPlan(plan([
  change("aws_efs_file_system.database[0]", "aws_efs_file_system", ["no-op"], { tags: { ...tags, Persistence: "retained" } }, { tags: { ...tags, Persistence: "retained" } }),
  change("aws_efs_access_point.database[0]", "aws_efs_access_point", ["no-op"], { tags: { ...tags, Persistence: "retained" } }, { tags: { ...tags, Persistence: "retained" } }),
]), scope);
assert.equal(adoptedEfsPlan.summary.create, 0, "successful retained EFS adoption cannot leave a CreateFileSystem action");

class PersistentPort implements PersistentResourceLifecyclePort {
  imports: Array<{ address: string; id: string }> = [];
  constructor(readonly resources: Map<string, PersistentResourceDescription[]>, readonly state = new Set<string>()) {}
  async findExact(expectation: PersistentResourceExpectation) { return this.resources.get(`${expectation.kind}:${expectation.identity}`) || []; }
  async stateAddresses() { return new Set(this.state); }
  async importResource(expectation: PersistentResourceExpectation, id: string) { this.imports.push({ address: expectation.resourceAddress, id }); this.state.add(expectation.resourceAddress); }
}
const persistentVariables = {
  project_id: projectId,
  environment_name: "dev",
  manage_ecr_repository: true,
  ecr_repository_name: `deployguard-${projectId}`,
  enable_efs: true,
  database_service: { enabled: true, persistence_enabled: true, efs_enabled: true },
};
const expectations = expectedPersistentResources(persistentVariables);
assert.deepEqual(expectations.map((item) => item.kind), ["ecr_repository", "efs_file_system", "efs_access_point", "efs_file_system", "efs_access_point"]);
const missingPort = new PersistentPort(new Map());
const missing = await new PersistentResourceLifecycleReconciler(missingPort).reconcile(expectations);
assert.ok(missing.every((item) => item.status === "missing" && item.importResult === "not_required"));
assert.equal(missingPort.imports.length, 0, "first deployment leaves resource creation to Terraform");
const ecr = expectations[0];
const owned: PersistentResourceDescription = { id: ecr.identity, identity: ecr.identity, tags: ecr.requiredTags };
const activePort = new PersistentPort(new Map([[`${ecr.kind}:${ecr.identity}`, [owned]]]));
const imported = await new PersistentResourceLifecycleReconciler(activePort).reconcile([ecr]);
assert.equal(imported[0].importResult, "imported");
const repeatedPersistent = await new PersistentResourceLifecycleReconciler(activePort).reconcile([ecr]);
assert.equal(repeatedPersistent[0].importResult, "not_required");
assert.equal(activePort.imports.length, 1, "repeated persistent-resource planning must be idempotent");
const wrongTags = { ...owned, tags: { ...owned.tags, DeployGuardProjectId: otherProject } };
await assert.rejects(new PersistentResourceLifecycleReconciler(new PersistentPort(new Map([[`${ecr.kind}:${ecr.identity}`, [wrongTags]]]))).reconcile([ecr]), /ownership verification/);
await assert.rejects(new PersistentResourceLifecycleReconciler(new PersistentPort(new Map([[`${ecr.kind}:${ecr.identity}`, [owned, owned]]]))).reconcile([ecr]), /ambiguous/);
assert.deepEqual(expectedPersistentResources({ ...persistentVariables, manage_ecr_repository: false, enable_efs: false, database_service: { enabled: false } }), []);
const runner = new TerraformRunnerService(new ConfigService({}));
assert.deepEqual(runner.buildTerraformInitArgs({ mode: "s3", configPath: "/safe/backend.hcl" }), ["init", "-input=false", "-no-color", "-reconfigure", "-backend-config=/safe/backend.hcl"]);
assert.throws(() => runner.buildTerraformInitArgs({ mode: "s3" }), /explicit backend configuration/);
assert.doesNotMatch(runner.buildTerraformInitArgs({ mode: "s3", configPath: "/safe/backend.hcl" }).join(" "), /-backend=false/);

const marker = `prefix\nDEPLOYGUARD_PLAN_SUMMARY=${JSON.stringify({ ...first.summary, safety: "passed" })}\nsuffix`;
assert.deepEqual(extractGithubActionsTerraformPlanSummary(marker), { ...first.summary, safety: "passed" });
assert.equal(extractGithubActionsTerraformPlanSummary('DEPLOYGUARD_PLAN_SUMMARY={"create":1,"safety":"passed","secret":"value"}'), null);

const root = join(__dirname, "../..");
const workflow = readFileSync(join(root, ".github/workflows/deployguard-reusable.yml"), "utf8");
const generationCostTarget = "' deployguard-plan.json > deployguard-cost-plan.json";
const generationCostEnd = workflow.indexOf(generationCostTarget);
const redactionStart = workflow.lastIndexOf("          jq '\n", generationCostEnd);
assert.ok(redactionStart >= 0 && generationCostEnd > redactionStart, "the generation cost-plan redaction filter must be extractable");
const redactionFilter = workflow.slice(redactionStart + "          jq '\n".length, generationCostEnd)
  .split("\n").map((line) => line.startsWith("            ") ? line.slice(12) : line).join("\n");
const noOpRedaction = spawnSync("jq", [redactionFilter], { input: JSON.stringify({ format_version: "1.2", resource_changes: null }), encoding: "utf8" });
assert.equal(noOpRedaction.status, 0, noOpRedaction.stderr || "Terraform no-op plans must remain valid cost evidence");
assert.deepEqual(JSON.parse(noOpRedaction.stdout).resource_changes, [], "a null Terraform resource_changes value normalizes to an empty array");
assert.match(workflow, /deployguard-project-cost-plan\.json/, "project-scoped Terraform cost evidence is uploaded with the generation plan");
const start = workflow.indexOf("          cat > .deployguard/terraform/main.tf <<'TERRAFORM'\n");
const bodyStart = start + "          cat > .deployguard/terraform/main.tf <<'TERRAFORM'\n".length;
const end = workflow.indexOf("          TERRAFORM\n", bodyStart);
assert.ok(start >= 0 && end > bodyStart, "the exact reusable-workflow Terraform heredoc must be materializable");
const hcl = workflow.slice(bodyStart, end).split("\n").map((line) => line.startsWith("          ") ? line.slice(10) : line).join("\n") + "\n";
const fixture = mkdtempSync(join(tmpdir(), "deployguard-preplan-"));
writeFileSync(join(fixture, "main.tf"), hcl);
execFileSync("terraform", ["fmt", "-check", "-recursive"], { cwd: fixture, stdio: "pipe" });
execFileSync("terraform", ["init", "-backend=false", "-input=false", "-no-color"], { cwd: fixture, stdio: "pipe" });
execFileSync("terraform", ["validate", "-no-color"], { cwd: fixture, stdio: "pipe" });

for (const required of [
  /terraform fmt -check -recursive -diff/,
  /terraform init -input=false[\s\S]*backend-config="bucket=/,
  /terraform validate -no-color/,
  /terraform plan -detailed-exitcode/,
  /PLAN_EXIT_CODE/,
  /Terraform plan safety policy rejected/,
  /DEPLOYGUARD_PLAN_SUMMARY=/,
  /failed DeployGuard ownership verification/,
  /list-tags-for-resource --resource-arn/,
  /generationStateKey == \("projects\/" \+ \$project/,
  /DeployGuardGenerationId == \$generation/,
  /describe-target-health --target-group-arn/,
]) assert.match(workflow, required);
assert.doesNotMatch(workflow, /terraform import|terraform state rm|terraform untaint/, "the generation-isolated workflow must not adopt legacy remote residue");
assert.doesNotMatch(workflow, /terraform init[^\n]*-backend=false/);
assert.doesNotMatch(workflow, /["']logs:\*["']/);
const policyMatch = workflow.match(/--arg namespace "\$INFRASTRUCTURE_NAMESPACE" '\n([\s\S]*?)\n          ' deployguard-plan\.json/);
assert.ok(policyMatch?.[1], "the exact workflow plan policy must be extractable");
const jqPolicy = policyMatch![1].split("\n").map((line) => line.startsWith("            ") ? line.slice(12) : line).join("\n");
const safePolicy = spawnSync("jq", ["-e", "--arg", "action", "deploy", "--arg", "project", projectId, "--arg", "environment", "dev", "--arg", "generation", generationId, "--arg", "persistent_state", "PERSISTENT", "--arg", "recovery_available", "false", "--arg", "namespace", scope.infrastructureNamespace, jqPolicy], { input: plan([change("aws_ecs_service.app", "aws_ecs_service", ["update"], { tags }, { tags })]), encoding: "utf8" });
assert.equal(safePolicy.status, 0, safePolicy.stderr);
const ownedDestroyPolicy = spawnSync("jq", ["-e", "--arg", "action", "destroy", "--arg", "project", projectId, "--arg", "environment", "dev", "--arg", "generation", generationId, "--arg", "persistent_state", "PERSISTENT", "--arg", "recovery_available", "false", "--arg", "namespace", scope.infrastructureNamespace, jqPolicy], { input: plan([change("aws_efs_file_system.data", "aws_efs_file_system", ["delete"], {}, { tags })]), encoding: "utf8" });
assert.equal(ownedDestroyPolicy.status, 0, "Destroy may delete persistent resources owned by the exact generation");
const otherGenerationDestroyPolicy = spawnSync("jq", ["-e", "--arg", "action", "destroy", "--arg", "project", projectId, "--arg", "environment", "dev", "--arg", "generation", generationId, "--arg", "persistent_state", "PERSISTENT", "--arg", "recovery_available", "false", "--arg", "namespace", scope.infrastructureNamespace, jqPolicy], { input: plan([change("aws_efs_file_system.data", "aws_efs_file_system", ["delete"], {}, { tags: { ...tags, DeployGuardGenerationId: "22222222-2222-4222-8222-222222222222" } })]), encoding: "utf8" });
assert.notEqual(otherGenerationDestroyPolicy.status, 0, "Destroy must reject persistent resources owned by another generation");
const destroyLogGroupPolicy = spawnSync("jq", ["-e", "--arg", "action", "destroy", "--arg", "project", projectId, "--arg", "environment", "dev", "--arg", "generation", generationId, "--arg", "persistent_state", "PERSISTENT", "--arg", "recovery_available", "false", "--arg", "namespace", scope.infrastructureNamespace, jqPolicy], { input: plan([change("aws_cloudwatch_log_group.app", "aws_cloudwatch_log_group", ["delete"], {}, { name: `${scope.infrastructureNamespace}/app`, tags })]), encoding: "utf8" });
assert.equal(destroyLogGroupPolicy.status, 0, destroyLogGroupPolicy.stderr || "normal destroy must be allowed to remove its project log groups");
const deployment = readFileSync(join(root, "backend/src/projects/github-actions-deployment.service.ts"), "utf8");
assert.match(deployment, /terraformPlanSummary/);
assert.match(deployment, /extractGithubActionsTerraformPlanSummary/);
const infrastructure = readFileSync(join(root, "backend/src/infrastructure/infrastructure.service.ts"), "utf8");
assert.ok(infrastructure.indexOf("runTerraformFmtCheck") < infrastructure.indexOf("runTerraformInit"));
assert.ok(infrastructure.indexOf("runTerraformInit") < infrastructure.indexOf("reconcileBeforePlan"));
assert.ok(infrastructure.indexOf("runTerraformValidate") < infrastructure.indexOf("runTerraformPlanDetailed"));
assert.match(infrastructure, /PersistentResourceLifecycleService/);
assert.match(infrastructure, /terraformPrePlanReconciliation/);

  console.log("Iteration 7 Terraform pre-plan checks passed: exact HCL formatting, backend initialization, ownership reconciliation, detailed planning, retained-resource policy, idempotent fixtures and sanitized evidence persistence.");
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Terraform pre-plan verification failed.");
  process.exitCode = 1;
});
