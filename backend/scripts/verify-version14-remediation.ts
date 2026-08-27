import { strict as assert } from "node:assert";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ConfigService } from "@nestjs/config";
import { InfrastructureService } from "../src/infrastructure/infrastructure.service";
import { TerraformRunnerService } from "../src/infrastructure/terraform-runner.service";
import { analysisFingerprint, detectionFingerprint } from "../src/projects/analysis-fingerprint";
import { PIPELINE_LIFECYCLE_REGISTRY, PIPELINE_STAGE_REGISTRY } from "../src/projects/pipeline/pipeline-stage-registry";
import { PipelineStageResolverService } from "../src/projects/current-state/pipeline-stage-resolver.service";
import { PipelineRunStatus } from "../src/projects/project-pipeline-run.entity";

async function workspaceService(config: ConfigService) {
  const service = Object.create(InfrastructureService.prototype) as InfrastructureService;
  Reflect.set(service, "config", config);
  return service;
}

async function verifyTerraformBackendModes() {
  const root = await mkdtemp(join(tmpdir(), "deployguard-v14-terraform-"));
  const template = resolve(process.cwd(), "terraform/base-network");
  const localConfig = new ConfigService({
    TERRAFORM_WORKING_BASE_DIR: root,
    TERRAFORM_NETWORK_TEMPLATE_DIR: template,
    STATE_MOCK_MODE: "true",
  });
  const service = await workspaceService(localConfig);
  const workdir = await service.prepareInfrastructureWorkspace("project-1", "run-1");
  const versions = await readFile(join(workdir, "versions.tf"), "utf8");
  assert.match(versions, /backend\s+"local"/);
  assert.doesNotMatch(versions, /backend\s+"s3"/);
  await writeFile(join(workdir, "tfplan"), "stale", "utf8");
  await mkdir(join(workdir, ".terraform"), { recursive: true });
  await writeFile(join(workdir, ".terraform", "reuse-marker"), "keep", "utf8");
  await service.prepareInfrastructureWorkspace("project-1", "run-1");
  assert.equal(await readFile(join(workdir, ".terraform", "reuse-marker"), "utf8"), "keep");
  await assert.rejects(() => service.prepareInfrastructureWorkspace("../escape", "run-2"), /Invalid Terraform workspace identifier/);

  await writeFile(join(workdir, "terraform.tfstate"), "{\"version\":4}", "utf8");
  const remoteService = await workspaceService(new ConfigService({
    TERRAFORM_WORKING_BASE_DIR: root,
    TERRAFORM_NETWORK_TEMPLATE_DIR: template,
    STATE_MOCK_MODE: "false",
  }));
  await assert.rejects(
    () => remoteService.prepareInfrastructureWorkspace("project-1", "run-1"),
    /explicit state migration or a new run workspace is required/
  );

  const runner = new TerraformRunnerService(localConfig);
  assert.deepEqual(runner.buildTerraformInitArgs({ mode: "local" }), ["init", "-input=false", "-no-color"]);
  assert.deepEqual(
    runner.buildTerraformInitArgs({ mode: "s3", configPath: "/safe/backend.hcl" }),
    ["init", "-input=false", "-no-color", "-reconfigure", "-backend-config=/safe/backend.hcl"]
  );
  assert.doesNotMatch(runner.buildTerraformInitArgs({ mode: "local" }).join(" "), /backend=false/);

  const smoke = join(root, "smoke", "run");
  await mkdir(smoke, { recursive: true });
  await writeFile(join(smoke, "main.tf"), `terraform {
  required_version = ">= 1.5.0"
  backend "local" { path = "terraform.tfstate" }
}
resource "terraform_data" "smoke" { input = "deployguard-version-14" }
`, "utf8");
  await writeFile(join(smoke, "terraform.tfvars.json"), "{}", "utf8");
  await runner.runTerraformInit(smoke, {}, { mode: "local" });
  await runner.runTerraformValidate(smoke);
  await runner.runTerraformPlan(smoke);
  const show = await runner.runTerraformShowJson(smoke);
  const parsed = JSON.parse(show.stdout) as { format_version?: string };
  assert.ok(parsed.format_version, "terraform show -json must return parseable plan JSON");
  await rm(root, { recursive: true, force: true });
}

function verifyCanonicalLifecycle() {
  assert.deepEqual(
    PIPELINE_LIFECYCLE_REGISTRY.map((stage) => stage.key),
    [
      "validate_inputs", "clone_repository", "stack_detection_snapshot", "deployability_preflight",
      "external_ci_validation", "container_configuration", "docker_build", "ecr_push", "terraform_plan",
      "finops", "terraform_apply_gate", "terraform_apply", "database_tier_setup", "efs", "ecs_deploy", "alb_health",
      "stable_release", "observability", "complete",
    ]
  );
  assert.ok(PIPELINE_STAGE_REGISTRY.find((stage) => stage.key === "dockerfile_security_check")?.aliases.includes("dockerfile_check"));
  const planOrder = PIPELINE_STAGE_REGISTRY.find((stage) => stage.key === "terraform_plan")!.order;
  const finopsOrder = PIPELINE_STAGE_REGISTRY.find((stage) => stage.key === "finops_estimate")!.order;
  assert.ok(planOrder < finopsOrder, "Terraform plan must precede FinOps");
}

function verifyHistoricalResolution() {
  const resolver = new PipelineStageResolverService();
  const at = new Date("2026-07-14T17:00:00.000Z");
  const event = (stage: string, status: string) => ({ stage, status, message: `${stage} ${status}`, createdAt: at, metadata: {} });
  const stages = resolver.resolve({
    run: { status: PipelineRunStatus.FAILED, currentStage: "building_image" } as never,
    events: [
      event("preparing", "success"), event("github_actions_skipped", "skipped"),
      event("cloning", "success"), event("stack_detection_snapshot", "success"),
      event("dockerfile_generated", "success"), event("dockerfile_check_passed", "success"),
      event("building_image", "failed"),
    ] as never,
    applyEnabled: false,
    githubActionsRequired: false,
    hasRuntimeSignals: false,
    hasDeployment: false,
    hasStableRelease: false,
    costTierWarningOnly: false,
  });
  assert.equal(stages.find((stage) => stage.stage === "validate_inputs")?.status, "passed");
  assert.equal(stages.find((stage) => stage.stage === "external_ci_validation")?.status, "skipped");
  assert.equal(stages.find((stage) => stage.stage === "dockerfile_security_check")?.status, "passed");
  assert.equal(stages.find((stage) => stage.stage === "docker_build")?.status, "failed");
  assert.equal(resolver.resolveLifecycle(stages).find((stage) => stage.stage === "docker_build")?.status, "failed");
}

function verifyFingerprints() {
  const first = analysisFingerprint({ branch: "main", repo: "org/app", config: { port: 3000 } });
  const reordered = analysisFingerprint({ config: { port: 3000 }, repo: "org/app", branch: "main" });
  assert.equal(first, reordered, "fingerprints must be stable across object key order");
  assert.notEqual(first, analysisFingerprint({ branch: "release", repo: "org/app", config: { port: 3000 } }));
  const project = { repositoryFullName: "org/app", repositoryUrl: "https://github.com/org/app", targetBranch: "main", appDirectory: "api" };
  assert.notEqual(
    detectionFingerprint(project as never, "a".repeat(40)),
    detectionFingerprint(project as never, "b".repeat(40)),
    "a commit change must invalidate detection"
  );
}

async function main() {
  verifyCanonicalLifecycle();
  verifyHistoricalResolution();
  verifyFingerprints();
  await verifyTerraformBackendModes();
  console.log("VERSION-14 lifecycle, fingerprint, and Terraform backend checks passed.");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
