import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DeploymentCheckpointService } from "../src/projects/recovery/deployment-checkpoint.service";
import { DatabaseRequirementAnalyzer } from "../src/projects/recovery/database-requirement-analyzer.service";
import { DeploymentRecoveryPlanner } from "../src/projects/recovery/deployment-recovery-planner.service";
import { EcsDiagnosticsClassifier } from "../src/projects/recovery/ecs-diagnostics-classifier.service";
import { PreflightIssueMapper } from "../src/projects/recovery/preflight-issue-mapper.service";
import { StorageRequirementAnalyzer } from "../src/projects/recovery/storage-requirement-analyzer.service";
import { ProjectCurrentStateService } from "../src/projects/current-state/project-current-state.service";
import { selectCurrentRecoveryIssue } from "../src/projects/current-state/current-run-state";
import { CurrentStateInvalidationService } from "../src/state-management/current-state-invalidation.service";
import { StateValidationStatus } from "../src/state-management/project-state-validation-result.entity";
import { TerraformLockStatus } from "../src/state-management/project-terraform-lock.entity";
import { TerraformStateStatus } from "../src/state-management/project-terraform-state.entity";
import { resolveTerraformStateSafety } from "../src/state-management/terraform-state-safety-snapshot.service";

const oldHeartbeat = new Date("2026-07-20T10:00:00.000Z");
const releaseAt = new Date("2026-07-20T11:00:00.000Z");
const validationAt = new Date("2026-07-20T11:05:00.000Z");
const recoveredAt = new Date("2026-07-20T11:03:00.000Z");
const activity = {
  isDeploymentJobActive: false,
  activePipelineRunId: null,
  latestRunStatus: "failed",
  latestRunIsStale: true,
} as any;

const snapshot = resolveTerraformStateSafety({
  projectId: "846665b9-ce31-405d-a131-b84457d80932",
  state: {
    status: TerraformStateStatus.RECOVERED,
    currentVersionId: "s3-version-current",
    resourceCount: 75,
    lastValidatedAt: validationAt,
    updatedAt: recoveredAt,
  } as any,
  lock: {
    lockId: "historical-lock",
    status: TerraformLockStatus.RELEASED,
    heartbeatAt: oldHeartbeat,
    acquiredAt: oldHeartbeat,
    staleAfterSeconds: 300,
    releasedAt: releaseAt,
    updatedAt: releaseAt,
  } as any,
  validation: {
    status: StateValidationStatus.WARNING,
    stateVersionId: "older-s3-version",
    resourceCount: 38,
    createdAt: new Date("2026-07-20T10:30:00.000Z"),
  } as any,
  recovery: null,
  activeQueue: [],
  activity,
  invalidation: { generation: 1, invalidatedAt: validationAt.toISOString(), reason: "terraform_state_validated" },
  nowMs: Date.parse("2026-07-22T12:00:00.000Z"),
});

assert.equal(snapshot.stateStatus, TerraformStateStatus.RECOVERED);
assert.equal(snapshot.lockStatus, TerraformLockStatus.RELEASED, "a released lock must not become stale because its old heartbeat aged");
assert.equal(snapshot.validationStatus, StateValidationStatus.VALID, "the latest successful validation must be authoritative");
assert.equal(snapshot.sources.validationStatus.source, "project_terraform_states.last_validated_at (completed recovery)");
assert.equal(snapshot.resourceCount, 75);
assert.equal(snapshot.queueActive, false);
assert.equal(snapshot.activePipelineRunId, null);
assert.equal(snapshot.recoveryRequired, false);
assert.equal(snapshot.supersedesHistoricalFailuresAt, validationAt.toISOString());

const planner = new DeploymentRecoveryPlanner(
  new DeploymentCheckpointService(),
  new PreflightIssueMapper(),
  new EcsDiagnosticsClassifier(),
  new DatabaseRequirementAnalyzer(),
  new StorageRequirementAnalyzer(),
);
const recovery = planner.plan({
  projectId: "846665b9-ce31-405d-a131-b84457d80932",
  repositoryFullName: "example/app",
  branch: "main",
  contract: null,
  preflight: null,
  run: {
    id: "old-failed-run",
    status: "failed",
    currentStage: "state_lock",
    errorMessage: "Terraform state lock heartbeat is stale",
    updatedAt: new Date("2026-07-20T10:05:00.000Z"),
  } as any,
  events: [{
    status: "failed",
    message: "Terraform state lock heartbeat is stale and requires recovery.",
    createdAt: new Date("2026-07-20T10:05:00.000Z"),
  }] as any,
  scan: null,
  cost: null,
  environment: { status: "provisioned" } as any,
  lock: { status: TerraformLockStatus.RELEASED } as any,
  storage: null,
  deployment: null,
  databaseTier: null,
  cloudState: {
    deploymentStatus: "unhealthy",
    healthStatus: "unreachable",
    infrastructureStatus: "provisioned",
    resourceStatus: "active_resources",
    cleanupStatus: "not_requested",
    cloudVerificationStatus: "verified",
    inventoryStatus: "scanned",
    adminActionRequired: false,
    nextAction: "view_ecs_diagnostics",
    statusExplanation: "Infrastructure provisioned, but app live verification failed.",
    lastCloudVerifiedAt: validationAt.toISOString(),
    lastInventoryScanId: "scan-1",
    verificationTtlSeconds: 180,
    evidence: {},
  } as any,
  isDeploymentJobActive: false,
  stateSafety: snapshot,
} as any);

assert.equal(recovery?.code, "terraform_recovery_completed_resume", "an old stale-lock event must not override newer recovery evidence");
assert.notEqual(recovery?.code, "state_lock_stuck");
assert.equal(recovery?.primaryActionLabel, "Resume deployment");
assert.equal(recovery?.resumeFromStage, "terraform_plan");

const applyGateSelection = selectCurrentRecoveryIssue(recovery, { isPausedAtApplyGate: true } as any, null);
assert.equal(applyGateSelection, null, "historical recovery evidence must not override a newer run waiting for apply approval");
const reconciled = (Object.create(ProjectCurrentStateService.prototype) as any).withRecoveryDecision({
  phase: "apply_gate",
  overallStatus: "paused",
  userFacingStatus: "Infrastructure changes are waiting for approval.",
  currentStep: "terraform_apply_gate",
  currentStepLabel: "Terraform Apply Approval Required",
  nextAction: { type: "approve_apply", label: "Approve infrastructure changes" },
  blockedBy: null,
}, applyGateSelection, "846665b9-ce31-405d-a131-b84457d80932", true);
assert.equal(reconciled.nextAction.type, "approve_apply");
assert.equal(reconciled.nextAction.label, "Approve infrastructure changes");
assert.equal(reconciled.blockedBy, null, "a recovered-state warning must not coexist with a stale-lock blocker");

const invalidation = new CurrentStateInvalidationService();
assert.equal(invalidation.current("project").generation, 0);
const first = invalidation.invalidate("project", "terraform_state_validated");
const second = invalidation.invalidate("project", "terraform_lock_released");
assert.equal(first.generation, 1);
assert.equal(second.generation, 2);
assert.equal(second.reason, "terraform_lock_released");

const currentStateSource = readFileSync(join(__dirname, "../src/projects/current-state/project-current-state.service.ts"), "utf8");
const stateControllerSource = readFileSync(join(__dirname, "../src/state-management/state-management.controller.ts"), "utf8");
const stateManagementSource = readFileSync(join(__dirname, "../src/state-management/state-management.service.ts"), "utf8");
assert.match(currentStateSource, /terraformStateSafety:\s*stateSafety/);
assert.match(currentStateSource, /withRecoveryDecision\(productState, currentRecoveryIssue/);
assert.match(stateControllerSource, /safety-snapshot/);
assert.match(stateControllerSource, /Cache-Control[\s\S]*no-store/);
assert.match(stateManagementSource, /invalidate\(project\.id, "terraform_state_validated"\)/);

console.log("Terraform state safety synchronization verification passed (release precedence, validation precedence, stale-event suppression, recovery routing, and invalidation).\n");
