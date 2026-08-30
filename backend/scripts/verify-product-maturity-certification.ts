import "reflect-metadata";
import { strict as assert } from "node:assert";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ProjectsController } from "../src/projects/projects.controller";
import { ProjectCurrentStateService } from "../src/projects/current-state/project-current-state.service";
import { RailpackDeploymentService } from "../src/projects/railpack-deployment.service";
import { PipelineRunStatus } from "../src/projects/project-pipeline-run.entity";
import {
  deployguardOperationStagePresentation,
  githubActionsWorkflowStepPresentation,
} from "../src/projects/pipeline/github-actions-stage-presentation";

const root = join(__dirname, "..", "..");
const user = { id: "11111111-1111-4111-8111-111111111111" } as any;

function stageVocabulary() {
  const cases: Array<[unknown, "deploy" | "rollback" | "destroy", string]> = [
    ["checkout_exact_application_source", "deploy", "Checkout Source"],
    ["configure_aws_credentials_through_oidc", "deploy", "Authenticate AWS"],
    ["validate_immutable_release_input", "deploy", "Validate Release"],
    ["install_pinned_railpack", "deploy", "Prepare Build"],
    ["build_immutable_railpack_image", "deploy", "Build Application"],
    ["validate_application_runtime", "deploy", "Validate Application Runtime"],
    ["publish_immutable_image_to_ecr", "deploy", "Publish Image"],
    ["materialize_release_runtime", "deploy", "Deploy Runtime and Verify Application"],
    ["release_complete", "deploy", "Finalize Release"],
    ["select_immutable_rollback_image", "rollback", "Restore Release"],
    ["materialize_release_runtime", "rollback", "Update Runtime and Verify Application"],
    ["release_complete", "rollback", "Finalize Rollback"],
    ["materialize_release_runtime", "destroy", "Destroy Infrastructure"],
    ["release_evidence_validation", "destroy", "Verify Deletion"],
    ["project_delete_cleanup", "destroy", "Finalize Cleanup"],
  ];
  for (const [key, action, expected] of cases) assert.equal(deployguardOperationStagePresentation(key, action).label, expected);
  assert.equal(githubActionsWorkflowStepPresentation("Install pinned Railpack", "deploy")?.label, "Prepare Build");
  assert.equal(githubActionsWorkflowStepPresentation("Validate application runtime", "deploy")?.label, "Validate Application Runtime");
  assert.equal(githubActionsWorkflowStepPresentation("Materialize release runtime", "destroy")?.label, "Destroy Infrastructure");
  assert.equal(githubActionsWorkflowStepPresentation("Publish verified release result", "rollback")?.label, "Finalize Rollback");

  const deployment = Object.create(RailpackDeploymentService.prototype) as any;
  const presented = deployment.presentOperation({
    id: "22222222-2222-4222-8222-222222222222",
    status: PipelineRunStatus.FAILED,
    currentStage: "materialize_release_runtime",
    commitSha: "a".repeat(40),
    generationId: null,
    createdAt: new Date(),
    startedAt: new Date(),
    completedAt: null,
    failedAt: new Date(),
    githubWorkflowRunId: "123",
    githubWorkflowStatus: "completed",
    errorMessage: "Runtime update failed.",
    metadata: {
      deploymentAction: "destroy",
      failedStage: "materialize_release_runtime",
      workflowStages: [{ key: "materialize_release_runtime", label: "Materializing runtime", status: "failed" }],
    },
  });
  assert.equal(presented.stageLabel, "Destroy Infrastructure");
  assert.equal(presented.failedStageLabel, "Destroy Infrastructure");
  assert.equal(presented.workflowStages[0].label, "Destroy Infrastructure", "stale persisted labels must be re-presented canonically");
}

async function workspaceCounts(size: number) {
  const controller = Object.create(ProjectsController.prototype) as any;
  const projects = Array.from({ length: size }, (_, index) => ({
    id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    name: `project-${index}`,
    createdAt: new Date(),
    activity: null,
  }));
  let bulkReads = 0;
  let stateReads = 0;
  controller.projectsService = { listProjects: async () => projects };
  controller.githubActionsDeployment = { reconcileVisibleProjects: async (_user: unknown, ids: string[]) => { bulkReads += 1; assert.equal(ids.length, size); } };
  controller.projectCurrentStateService = { getCurrentState: async (_user: unknown, _id: string, options: unknown) => {
    stateReads += 1;
    assert.deepEqual(options, { skipReconciliation: true });
    return { developerState: "ready", stableRelease: null, stateAuthority: {} };
  } };
  await controller.getWorkspaceSummary({ user } as any);
  assert.equal(bulkReads, 1);
  assert.equal(stateReads, size);
}

async function coalescesRuntimeObservation() {
  const service = Object.create(ProjectCurrentStateService.prototype) as any;
  service.runtimeObservationCache = new Map();
  service.runtimeObservationInFlight = new Map();
  let providerReads = 0;
  service.readRuntimeObservation = async () => {
    providerReads += 1;
    await Promise.resolve();
    return { observedAt: new Date().toISOString(), runtime: "present", resources: { ecs: "present", alb: "present", cloudWatch: "present" }, evidence: null };
  };
  await Promise.all(Array.from({ length: 20 }, () => service.runtimeObservation({ id: "project" }, "generation", "https://example.invalid")));
  await service.runtimeObservation({ id: "project" }, "generation", "https://example.invalid");
  assert.equal(providerReads, 1);
}

async function throttlesCompletedProjection() {
  const service = Object.create(RailpackDeploymentService.prototype) as any;
  service.reconciliationInFlight = new Map();
  service.completedReconciliationAfter = new Map();
  service.project = async () => ({});
  let findCalls = 0;
  let completedProjections = 0;
  service.runs = { find: async () => { findCalls += 1; return findCalls === 2 ? [{ id: "completed" }] : []; } };
  service.reconcile = async () => undefined;
  service.reconcileCompletedRelease = async () => { completedProjections += 1; };
  service.reconcileCostEvidence = async () => undefined;
  await service.reconcileActive(user, "project");
  await service.reconcileActive(user, "project");
  assert.equal(findCalls, 3, "two reads require two active queries but only one completed-history query");
  assert.equal(completedProjections, 1);
}

function repositoryPresentation() {
  const read = (file: string) => readFileSync(join(root, file), "utf8");
  const phases = read("frontend/src/utils/developerDeploymentPresentation.js");
  const overview = read("frontend/src/components/projects/ProjectOverviewLifecycle.jsx");
  const projects = read("frontend/src/pages/Projects.jsx");
  const settings = read("frontend/src/pages/ProjectSettings.jsx");
  const routes = read("frontend/src/routes/AppRoutes.jsx");
  const sidebar = read("frontend/src/components/layout/Sidebar.jsx");
  const dashboard = read("frontend/src/pages/Dashboard.jsx");
  const api = read("frontend/src/api/projectApi.js");
  const troubleshooting = read("frontend/src/pages/ProjectTroubleshooting.jsx");
  for (const label of ["Prepare Source", "Build Application", "Publish Image", "Deploy Runtime", "Verify Application", "Prepare Rollback", "Restore Release", "Update Runtime", "Finalize Rollback", "Destroy Infrastructure", "Verify Deletion", "Finalize Cleanup"]) assert.match(phases, new RegExp(label));
  assert.doesNotMatch(phases, /label: "Railpack/);
  assert.doesNotMatch(overview, /Operation \{acceptedOperation\.id\}|overview-generation-state|overview-evidence-line/);
  assert.doesNotMatch(projects, /abbreviated\(operation\)|Latest operation<\/span><strong title=\{operation/);
  assert.match(settings, /EnvironmentVariablesPanel/);
  assert.match(settings, /Managed database/);
  assert.doesNotMatch(settings, /\/requirements/);
  assert.match(routes, /section="\/settings"[\s\S]*requirements/);
  assert.doesNotMatch(sidebar, /setInterval|getProjectCurrentState/);
  assert.match(dashboard, /if \(!hasActiveOperation\) return undefined/);
  assert.match(api, /detailedCurrentStateRequests/);
  assert.match(troubleshooting, /operation\.failedStageLabel \|\| label\(operation\.failedStage\)/);
  for (const retired of ["Billing.jsx", "ProjectCost.jsx", "ProjectObservability.jsx", "ProjectOrchestration.jsx", "ProjectRecovery.jsx", "ProjectRollback.jsx", "ProjectStateManagement.jsx"]) {
    assert.equal(existsSync(join(root, "frontend", "src", "pages", retired)), false);
  }
}

void (async () => {
  stageVocabulary();
  for (const size of [1, 10, 50]) await workspaceCounts(size);
  await coalescesRuntimeObservation();
  await throttlesCompletedProjection();
  repositoryPresentation();
  console.log("PRODUCT_MATURITY_CERTIFICATION=PASS WORKSPACE_RECONCILIATION=1 AWS_OBSERVATION_FANOUT=1 RETIRED_SURFACES=UNREACHABLE");
})().catch((error) => { console.error(error); process.exitCode = 1; });
