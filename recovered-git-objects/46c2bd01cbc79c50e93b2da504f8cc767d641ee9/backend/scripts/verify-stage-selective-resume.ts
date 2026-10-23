import { strict as assert } from "node:assert";
import { PipelineRunStatus } from "../src/projects/project-pipeline-run.entity";
import { RecoveryIssue } from "../src/projects/recovery/recovery-issue.types";
import { StageSelectiveResumeService } from "../src/projects/recovery/stage-selective-resume.service";
import { RECOVERY_STAGES, RecoveryStage } from "../src/projects/recovery/stage-selective-resume.types";

const projectId = "11111111-1111-4111-8111-111111111111";
const sourceRun = {
  id: "22222222-2222-4222-8222-222222222222", projectId,
  commitSha: "a".repeat(40), imageName: "mini-paas/test", imageTag: "a".repeat(40),
  ecrRepositoryName: "test", ecrImageUri: `example.dkr.ecr.us-east-1.amazonaws.com/test:${"a".repeat(40)}`,
  status: PipelineRunStatus.FAILED, createdAt: new Date(),
};

const fingerprints = Object.fromEntries(RECOVERY_STAGES.map((stage) => [stage, `fp-${stage}`])) as Record<RecoveryStage, string>;
function checkpointMap(missing?: RecoveryStage) {
  return new Map(RECOVERY_STAGES.filter((stage) => stage !== missing).map((stage) => [stage, {
    id: `checkpoint-${stage}`, projectId, pipelineRunId: sourceRun.id, stage,
    fingerprint: fingerprints[stage], status: "passed", imageTag: sourceRun.imageTag, imageDigest: "sha256:verified",
  }])) as any;
}
function issue(code: string, category: RecoveryIssue["category"], resumeFromStage: string): RecoveryIssue {
  return {
    code, category, resumeFromStage, title: code, severity: "blocker", rootCause: code,
    simpleExplanation: code, detectedEvidence: [], requiredAction: `Fix ${code}`,
    primaryActionLabel: "Fix issue", primaryActionRoute: `/projects/${projectId}/settings`,
    primaryActionMode: "focused_settings", focusSection: null, canResume: true,
    requiresFullRerun: false, affectedStages: [], safeToRetry: true,
    developerDetails: { pipelineRunId: sourceRun.id },
  };
}

function harness(options: { missing?: RecoveryStage; current?: Partial<Record<RecoveryStage, string>> } = {}) {
  const savedEvents: any[] = [];
  const queued: any[] = [];
  const runs = {
    findOne: async (query: any) => query?.where?.status ? null : sourceRun,
    findOneOrFail: async () => sourceRun,
    create: (value: any) => value,
    save: async (value: any) => ({ id: value.id || "33333333-3333-4333-8333-333333333333", createdAt: new Date(), ...value }),
  };
  const events = { create: (value: any) => value, save: async (value: any) => { savedEvents.push(value); return value; } };
  const checkpoints = {
    currentFingerprints: async () => ({ ...fingerprints, ...(options.current || {}) }),
    latestPassedByStage: async () => checkpointMap(options.missing),
    recordPassed: async () => undefined,
    recordReused: async () => undefined,
  };
  const service = new StageSelectiveResumeService(
    runs as any, events as any,
    { findOne: async () => ({ id: "report", detectionProfileId: "profile", validationStatus: "passed" }) } as any,
    { getProjectEntityForManage: async () => ({ id: projectId, repositoryUrl: "https://github.com/example/app", repositoryFullName: "example/app", targetBranch: "main" }) } as any,
    { getOrGenerateReport: async () => ({ validationStatus: "passed" }) } as any,
    { startRun: async () => ({ id: "full-run" }) } as any,
    checkpoints as any,
    { record: async () => undefined } as any,
    { add: async (_name: string, payload: any) => { queued.push(payload); } } as any,
    { hasConfig: () => true, getImageDigest: async () => "sha256:verified" } as any,
    { refreshProjectResources: async () => ({ summary: { total: 0, status: "no_project_resources_found" } }) } as any,
    { inspect: async () => ({ isDeploymentJobActive: false }) } as any,
  );
  return { service, savedEvents, queued };
}

async function verify() {
  const runtime = await harness().service.decide(projectId, issue("missing_runtime_env_vars", "runtime", "ecs_task_definition"));
  assert.equal(runtime.mode, "resume");
  assert.equal(runtime.resumeFromStage, "ecs_task_definition_update");
  assert.equal(runtime.rerunStages.includes("docker_build"), false);
  assert.equal(runtime.rerunStages.includes("ecs_service_deploy"), true);

  const database = await harness().service.decide(projectId, issue("database_service_unhealthy", "database", "database_tier_setup"));
  assert.equal(database.resumeFromStage, "database_tier_setup");
  assert.deepEqual(database.rerunStages.slice(0, 3), ["terraform_plan", "terraform_apply", "database_tier_setup"]);
  assert.equal(database.rerunStages.includes("database_tier_setup"), true);
  assert.equal(database.rerunStages.includes("docker_build"), false);

  const databaseSecurityGroup = await harness().service.decide(projectId, issue("terraform_database_security_group_description_invalid", "terraform", "terraform_plan"));
  assert.equal(databaseSecurityGroup.mode, "resume");
  assert.equal(databaseSecurityGroup.resumeFromStage, "terraform_plan");
  assert.deepEqual(databaseSecurityGroup.rerunStages.slice(0, 3), ["terraform_plan", "terraform_apply", "database_tier_setup"]);
  for (const reusable of ["repo_clone", "docker_build", "security_scan", "ecr_push"] as RecoveryStage[]) {
    assert.equal(databaseSecurityGroup.rerunStages.includes(reusable), false);
    assert.equal(databaseSecurityGroup.skippedStages.includes(reusable), true);
  }
  assert.equal(databaseSecurityGroup.rerunStages.includes("ecs_service_deploy"), true);
  assert.equal(databaseSecurityGroup.rerunStages.includes("health_check"), true);

  const health = await harness().service.decide(projectId, issue("health_check_path_missing", "health", "alb_health"));
  assert.equal(health.resumeFromStage, "health_check");
  assert.equal(health.rerunStages.includes("docker_build"), false);

  const cost = await harness().service.decide(projectId, issue("cost_gate_blocked", "cost", "terraform_apply"));
  assert.equal(cost.resumeFromStage, "terraform_apply");
  assert.equal(cost.rerunStages.includes("docker_build"), false);

  const changedSource = await harness({ current: { repo_clone: "changed-source" } }).service.decide(projectId, issue("branch_not_found", "source", "repo_clone"));
  assert.equal(changedSource.mode, "full");
  assert.equal(changedSource.sourceImageUri, null);

  const missingCheckpoint = await harness({ missing: "repo_clone" }).service.decide(projectId, issue("missing_runtime_env_vars", "runtime", "ecs_task_definition"));
  assert.equal(missingCheckpoint.mode, "full");
  assert.match(missingCheckpoint.fallbackReason || "", /repository checkpoint/i);

  const unsafeImage = await harness({ missing: "ecr_push" }).service.decide(projectId, issue("critical_vulnerability_blocked", "security", "security_scan"));
  assert.equal(unsafeImage.mode, "full");
  assert.equal(unsafeImage.sourceImageUri, null);

  const execution = harness();
  const result = await execution.service.execute({ id: 7 } as any, projectId, issue("missing_runtime_env_vars", "runtime", "ecs_task_definition"));
  assert.equal(result.queued, true);
  assert.equal(execution.queued[0].mode, "resume");
  assert.equal(execution.queued[0].resumeFromStage, "ecs_task_definition_update");
  assert.equal(execution.savedEvents.some((event) => event.status === "skipped" && event.message === "Reused from previous successful run."), true);

  const cleanup = harness();
  const cleanupResult = await cleanup.service.execute({ id: 7 } as any, projectId, issue("safe_leftovers_available", "cleanup", "cleanup_inventory"));
  assert.equal(cleanupResult.queued, false);
  assert.equal(cleanup.queued.length, 0);
}

verify().then(() => console.log("Stage-selective resume decisions, safe fallback, queue payload, reuse events, and cleanup routing passed."));
