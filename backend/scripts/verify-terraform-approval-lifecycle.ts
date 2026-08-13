import { strict as assert } from "node:assert";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PipelineStageResolverService } from "../src/projects/current-state/pipeline-stage-resolver.service";
import { PipelineRunStatus } from "../src/projects/project-pipeline-run.entity";
import { PipelineService } from "../src/projects/pipeline/pipeline.service";
import { TerraformApprovalStateService } from "../src/infrastructure/terraform-approval-state.service";

const projectId = "846665b9-ce31-405d-a131-b84457d80932";
const runId = "81bd6006-33ee-4830-a6bd-5be963dd9795";
const at = new Date("2026-07-22T09:51:07.770Z");
const event = (stage: string, status: string, occurredAt = at) => ({ stage, status, occurredAt, createdAt: occurredAt, sequenceNumber: 0, metadata: {} }) as any;
const pausedRun = () => ({
  id: runId,
  projectId,
  status: PipelineRunStatus.APPLY_DISABLED,
  currentStage: "terraform_apply_approval_required",
  metadata: { applyApprovalRequired: true },
  configurationSnapshotId: "snapshot-1",
  failedAt: null,
  createdAt: at,
}) as any;

async function approvalFixture() {
  const workdir = await mkdtemp(join(tmpdir(), "deployguard-plan-"));
  await writeFile(join(workdir, "tfplan"), "immutable-plan-artifact", { mode: 0o600 });
  const run = pausedRun();
  const snapshot = { id: "snapshot-1", projectId, pipelineRunId: runId, configurationFingerprint: "configuration-v1" } as any;
  const approvalEvents = [event("infrastructure_plan_completed", "success"), event("terraform_apply_approval_required", "waiting")];
  let latest = run;
  let configurationCurrent = true;
  const environment: any = {
    projectId,
    pipelineRunId: runId,
    terraformWorkspacePath: workdir,
    terraformPlanSummary: { create: 2, update: 3, delete: 0 },
    metadata: {},
    updatedAt: at,
  };
  const service = new TerraformApprovalStateService(
    { findOne: async () => latest } as any,
    { find: async () => approvalEvents } as any,
    { findOne: async () => environment } as any,
    { findOne: async () => snapshot } as any,
    { assertRunConfigurationCurrent: async () => { if (!configurationCurrent) throw new Error("changed"); return snapshot; } } as any,
  );
  const artifactSha256 = "f436cfdcec301eea849b9d2e5ca22c28f693792c9f01f75556bdeee72eebc59d";
  const contractFingerprint = "contract-v1";
  const terraformInputFingerprint = "terraform-input-v1";
  environment.metadata = {
    planArtifactSha256: artifactSha256,
    planConfigurationFingerprint: snapshot.configurationFingerprint,
    contractFingerprint,
    terraformInputFingerprint,
    planFingerprint: service.planFingerprint(artifactSha256, terraformInputFingerprint, runId, contractFingerprint),
    planGeneratedAt: new Date(Date.now() - 1_000).toISOString(),
    planExpiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
  return {
    service, run, environment, approvalEvents, workdir,
    setLatest(value: any) { latest = value; },
    setConfigurationCurrent(value: boolean) { configurationCurrent = value; },
  };
}

async function verifyApprovalEligibility() {
  const fixture = await approvalFixture();
  try {
    assert.equal((await fixture.service.evaluate(projectId, fixture.run)).eligible, true, "eligible paused run can be approved");

    fixture.setLatest({ ...fixture.run, id: "newer-run", createdAt: new Date() });
    assert.equal((await fixture.service.evaluate(projectId, fixture.run)).blockedReason, "run_superseded");
    fixture.setLatest(fixture.run);

    fixture.setConfigurationCurrent(false);
    assert.equal((await fixture.service.evaluate(projectId, fixture.run)).blockedReason, "configuration_changed");
    fixture.setConfigurationCurrent(true);

    fixture.environment.metadata.planExpiresAt = new Date(Date.now() - 1_000).toISOString();
    assert.equal((await fixture.service.evaluate(projectId, fixture.run)).blockedReason, "plan_stale");
    fixture.environment.metadata.planExpiresAt = new Date(Date.now() + 60_000).toISOString();

    const missingPlan = { ...fixture.environment, terraformPlanSummary: null };
    assert.equal((await fixture.service.evaluate(projectId, fixture.run, { environment: missingPlan })).blockedReason, "plan_missing");
    assert.equal((await fixture.service.evaluate(projectId, { ...fixture.run, metadata: { applyApprovedAt: at.toISOString() } })).blockedReason, "already_approved");
    assert.equal((await fixture.service.evaluate(projectId, { ...fixture.run, status: PipelineRunStatus.FAILED, failedAt: at })).blockedReason, "run_failed");
    assert.equal((await fixture.service.evaluate(projectId, { ...fixture.run, currentStage: "terraform_plan" })).blockedReason, "not_at_apply_gate");
    assert.equal((await fixture.service.evaluate(projectId, null)).blockedReason, "run_not_found");
  } finally {
    await rm(fixture.workdir, { recursive: true, force: true });
  }
}

function verifyLifecycleNormalization() {
  const resolver = new PipelineStageResolverService();
  const run = pausedRun();
  const stages = resolver.resolve({
    run,
    events: [
      event("repo_clone", "skipped"),
      event("infrastructure_plan_completed", "success"),
      event("cost_policy_evaluated", "success"),
      event("terraform_apply_approval_required", "waiting"),
      event("database_tier_setup", "running"),
    ],
    applyEnabled: true,
    githubActionsRequired: false,
    hasRuntimeSignals: false,
    hasDeployment: false,
    hasStableRelease: false,
    costTierWarningOnly: false,
  });
  assert.equal(stages.find((stage) => stage.stage === "terraform_apply_gate")?.status, "requires_approval");
  assert.equal(stages.find((stage) => stage.stage === "terraform_apply")?.status, "blocked");
  assert.equal(stages.find((stage) => stage.stage === "database_tier_setup")?.status, "blocked");
  assert.equal(stages.some((stage) => stage.status === "failed"), false, "approval-blocked stages are not failures");
  assert.equal(stages.find((stage) => stage.stage === "clone_repository")?.status, "skipped", "reused stage remains skipped");
  assert.equal(stages.find((stage) => stage.stage === "external_ci_validation")?.status, "skipped", "optional CI is skipped");

  const failedAfterApproval = resolver.resolve({
    run: { ...run, status: PipelineRunStatus.FAILED, currentStage: "terraform_apply_approval_queued", failedAt: new Date() },
    events: [event("terraform_apply_approval_required", "waiting", new Date(at.getTime() - 1_000)), event("terraform_apply_approval_queued", "failed", at)],
    applyEnabled: true,
    githubActionsRequired: false,
    hasRuntimeSignals: false,
    hasDeployment: false,
    hasStableRelease: false,
    costTierWarningOnly: false,
  });
  assert.equal(failedAfterApproval.find((stage) => stage.stage === "terraform_apply_gate")?.status, "failed", "new failure supersedes old approval evidence");
}

async function pipelineService(approval: { eligible: boolean; blockedReason: string | null }) {
  const run = pausedRun();
  let queued = 0;
  const runRepository = {
    findOne: async () => run,
    update: async () => ({ affected: 1 }),
  };
  const service = new PipelineService(
    runRepository as any,
    { create: (value: any) => value, save: async (value: any) => value } as any,
    {} as any,
    {} as any,
    { add: async () => { queued += 1; } } as any,
    { getProjectEntityForManage: async () => ({ id: projectId }) } as any,
    { record: async () => undefined } as any,
    { sanitize: (value: string) => value } as any,
    { recordUserAction: async () => undefined } as any,
    {} as any,
    { evaluate: async () => ({ ...approval, required: true }) } as any,
  );
  return { service, run, queued: () => queued };
}

async function verifyApprovalConsumption() {
  const eligible = await pipelineService({ eligible: true, blockedReason: null });
  await eligible.service.approveTerraformApply({ id: 1 } as any, projectId, runId);
  assert.equal(eligible.queued(), 1, "eligible approval is consumed and resume is queued once");

  const stale = await pipelineService({ eligible: false, blockedReason: "plan_stale" });
  await assert.rejects(
    () => stale.service.approveTerraformApply({ id: 1 } as any, projectId, runId),
    (error: any) => error.getResponse().code === "plan_stale",
  );
  assert.equal(stale.queued(), 0, "ineligible approval does not enqueue apply");
}

async function main() {
  await verifyApprovalEligibility();
  verifyLifecycleNormalization();
  await verifyApprovalConsumption();
  console.log("Terraform approval eligibility and canonical current-run lifecycle verification passed.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
