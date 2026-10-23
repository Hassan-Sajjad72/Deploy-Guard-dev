import { strict as assert } from "node:assert";
import { ProjectDeploymentStatus } from "../src/orchestration/project-deployment.entity";
import { deriveCurrentRunState, previousDeploymentIssue, selectCurrentRecoveryIssue } from "../src/projects/current-state/current-run-state";
import { PipelineStageResolverService } from "../src/projects/current-state/pipeline-stage-resolver.service";
import { PipelineRunStatus } from "../src/projects/project-pipeline-run.entity";
import { DeploymentCheckpointService } from "../src/projects/recovery/deployment-checkpoint.service";
import { DatabaseRequirementAnalyzer } from "../src/projects/recovery/database-requirement-analyzer.service";
import { DeploymentRecoveryPlanner } from "../src/projects/recovery/deployment-recovery-planner.service";
import { EcsDiagnosticsClassifier } from "../src/projects/recovery/ecs-diagnostics-classifier.service";
import { PreflightIssueMapper } from "../src/projects/recovery/preflight-issue-mapper.service";
import { StorageRequirementAnalyzer } from "../src/projects/recovery/storage-requirement-analyzer.service";

const run = {
  id: "8879d4af-9384-4199-b38b-1d9225bcd413",
  projectId: "846665b9-ce31-405d-a131-b84457d80932",
  status: PipelineRunStatus.APPLY_DISABLED,
  currentStage: "terraform_apply_approval_required",
  errorMessage: null,
} as any;
const at = new Date("2026-07-22T05:49:06.000Z");
const event = (stage: string, status: string, message = stage) => ({ stage, status, message, createdAt: at, occurredAt: at, metadata: {} }) as any;
const events = [
  event("terraform_plan", "success"),
  event("cost_policy_evaluated", "success"),
  event("terraform_apply", "running"),
  event("terraform_apply_approval_required", "waiting"),
  event("database_tier_setup", "running"),
];
const stages = new PipelineStageResolverService().resolve({
  run,
  events,
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

const failedAfterDatabase = new PipelineStageResolverService().resolve({
  run: { ...run, status: PipelineRunStatus.ECS_DEPLOYMENT_FAILED, currentStage: "ecs_service_deploy" },
  events: [
    event("database_tier_setup", "running"),
    event("ecs_service_deploy", "failed", "Application ECS service failed."),
  ],
  applyEnabled: true,
  githubActionsRequired: false,
  hasRuntimeSignals: false,
  hasDeployment: true,
  hasStableRelease: false,
  costTierWarningOnly: false,
});
assert.equal(
  failedAfterDatabase.find((stage) => stage.stage === "database_tier_setup")?.status,
  "warning",
  "a database stage without an explicit success event cannot be presented as passed",
);

const current = deriveCurrentRunState(run, stages, false, { type: "approve_apply", label: "Approve infrastructure changes" });
assert.equal(current?.status, "paused");
assert.equal(current?.isPausedAtApplyGate, true);
assert.equal(current?.hasStartedTerraformApply, false);
assert.equal(current?.hasStartedEcsDeployment, false);
assert.equal(current?.hasReachedHealthVerification, false);
assert.equal(selectCurrentRecoveryIssue({ code: "health_check_path_missing" } as any, current, null), null);

const priorDeployment = {
  id: "old-deployment",
  pipelineRunId: "old-run",
  status: ProjectDeploymentStatus.UNHEALTHY,
  healthCheckPath: "/api/health",
  failedAt: new Date("2026-07-21T09:37:42.412Z"),
} as any;
const historical = previousDeploymentIssue(current, priorDeployment, "unreachable");
assert.equal(historical?.historical, true);
assert.equal(historical?.healthPath, "/api/health");
assert.match(historical?.message || "", /re-evaluated after this deployment/i);

const planner = new DeploymentRecoveryPlanner(
  new DeploymentCheckpointService(),
  new PreflightIssueMapper(),
  new EcsDiagnosticsClassifier(),
  new DatabaseRequirementAnalyzer(),
  new StorageRequirementAnalyzer(),
);
const cloud = {
  deploymentStatus: "unhealthy", healthStatus: "unreachable", infrastructureStatus: "provisioned",
  resourceStatus: "active_resources", cleanupStatus: "not_requested", cloudVerificationStatus: "verified",
  inventoryStatus: "scanned", adminActionRequired: false, nextAction: "view_ecs_diagnostics",
  statusExplanation: "Previous app health is unreachable.", lastCloudVerifiedAt: at, lastInventoryScanId: null,
  verificationTtlSeconds: 180, evidence: {},
};
const stateSafety = {
  stateStatus: "healthy", lockStatus: "released", validationStatus: "passed", recoveryRequired: false,
  supersedesHistoricalFailuresAt: null, authoritativeTimestamp: at,
};
const plannerInput = {
  projectId: run.projectId, repositoryFullName: "example/app", branch: "main",
  contract: { blockers: [], missingEnvVars: [], buildTimeEnvVars: [], confidence: "high", healthPath: "/api/health" },
  preflight: null, run, events, scan: null, cost: null, environment: null, lock: null,
  storage: null, deployment: null, databaseTier: null, cloudState: cloud,
  isDeploymentJobActive: false, stateSafety,
} as any;
assert.notEqual(planner.plan(plannerInput)?.category, "health", "previous cloud health must not become the current apply-gate recovery issue");
const healthRun = { ...run, status: PipelineRunStatus.ECS_SERVICE_UNHEALTHY, currentStage: "alb_health", errorMessage: "Health check returned HTTP 404" };
const currentHealthIssue = planner.plan({ ...plannerInput, run: healthRun, events: [event("alb_health", "failed", "Health check returned HTTP 404")] });
assert.equal(currentHealthIssue?.category, "health", "health recovery is recomputed when the new run reaches health verification");

const staleLocalhostDiagnostic = planner.plan({
  ...plannerInput,
  run: { ...run, status: PipelineRunStatus.ECS_DEPLOYMENT_FAILED, currentStage: "ecs_service_deploy", errorMessage: "connect ECONNREFUSED 127.0.0.1:5432" },
  events: [event("ecs_service_deploy", "failed", "connect ECONNREFUSED 127.0.0.1:5432")],
  databaseServiceBinding: {
    id: "binding-v1",
    status: "applied",
    hostReference: `db.project-${run.projectId}.deployguard.local`,
  },
});
assert.equal(
  staleLocalhostDiagnostic?.code,
  "database_binding_not_verified",
  "older localhost diagnostics cannot override a newer private run binding",
);

console.log("Current-run and historical-recovery separation verification passed.\n");
