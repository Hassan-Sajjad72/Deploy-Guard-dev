import "reflect-metadata";
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  decideDeploymentRecovery,
  isDispatchableDeploymentRecoveryDecision,
} from "../src/projects/deployment-recovery-decision";
import { reviewGithubActionsTerraformPlan } from "../src/projects/github-actions-terraform-plan-policy";
import { GithubActionsDeploymentService } from "../src/projects/github-actions-deployment.service";
import { GITHUB_ACTIONS_INPUT_NAMES, GithubActionsOperationInputs, immutableDispatchFingerprint } from "../src/projects/github-actions-operation-contract";
import { PipelineRunStatus } from "../src/projects/project-pipeline-run.entity";
import { BUILD_PLAN_DETECTOR_VERSION } from "../src/projects/build-plan";

const input = {
  requestedMode: "DEPLOY" as const,
  persistentPreviouslyEstablished: false,
  currentPersistentResourcePresent: false,
  recoveryEvidenceAvailable: false,
  resetSupersedesPersistentGeneration: false,
};
const freshStateless = decideDeploymentRecovery(input);
assert.equal(freshStateless.deploymentMode, "FRESH");
assert.equal(freshStateless.persistentState, "NONE");
assert.equal(freshStateless.recoveryState, "NOT_REQUIRED");
assert.equal(freshStateless.deploymentAllowed, true);

const freshDatabase = decideDeploymentRecovery({ ...input });
assert.equal(freshDatabase.deploymentAllowed, true, "a new database does not require nonexistent recovery evidence");
assert.equal(isDispatchableDeploymentRecoveryDecision(freshDatabase), true, "fresh database context is dispatchable");

const failedBeforeDatabase = decideDeploymentRecovery({ ...input, requestedMode: "RETRY" });
assert.equal(failedBeforeDatabase.deploymentMode, "RETRY");
assert.equal(failedBeforeDatabase.persistentState, "NONE");
assert.equal(failedBeforeDatabase.deploymentAllowed, true);
assert.equal(isDispatchableDeploymentRecoveryDecision(failedBeforeDatabase), true, "retry after a failed first deployment does not invent persistent data");

const staleSecretOrBindingContext = decideDeploymentRecovery({ ...input });
assert.equal(staleSecretOrBindingContext.persistentPreviouslyEstablished, false);
assert.equal(staleSecretOrBindingContext.persistentState, "NONE");
assert.equal(isDispatchableDeploymentRecoveryDecision(staleSecretOrBindingContext), true,
  "stale secret or binding evidence cannot override the authoritative fresh context");

const safeUpdate = decideDeploymentRecovery({ ...input, persistentPreviouslyEstablished: true, currentPersistentResourcePresent: true });
assert.equal(safeUpdate.deploymentMode, "UPDATE");
assert.equal(safeUpdate.deploymentAllowed, true);
assert.equal(isDispatchableDeploymentRecoveryDecision(safeUpdate), true, "an existing persistent deployment verifies retained storage");

const updateWithBackup = decideDeploymentRecovery({ ...input, persistentPreviouslyEstablished: true, currentPersistentResourcePresent: true, recoveryEvidenceAvailable: true });
assert.equal(updateWithBackup.recoveryState, "AVAILABLE");
assert.equal(updateWithBackup.deploymentAllowed, true);

const missingWithoutBackup = decideDeploymentRecovery({ ...input, persistentPreviouslyEstablished: true });
assert.equal(missingWithoutBackup.recoveryState, "BLOCKED");
assert.equal(missingWithoutBackup.deploymentAllowed, false);
assert.equal(isDispatchableDeploymentRecoveryDecision(missingWithoutBackup), false, "missing persistent data without backup never reaches the workflow");

const missingWithBackup = decideDeploymentRecovery({ ...input, persistentPreviouslyEstablished: true, recoveryEvidenceAvailable: true });
assert.equal(missingWithBackup.deploymentMode, "RESTORE");
assert.equal(missingWithBackup.recoveryState, "AVAILABLE");
assert.equal(missingWithBackup.deploymentAllowed, false);
assert.equal(isDispatchableDeploymentRecoveryDecision(missingWithBackup), false, "missing persistent data with backup requires restore before dispatch");

const repeatedPersistentDeployment = decideDeploymentRecovery({
  ...input,
  persistentPreviouslyEstablished: true,
  currentPersistentResourcePresent: true,
});
assert.equal(repeatedPersistentDeployment.persistentState, "PERSISTENT");
assert.equal(isDispatchableDeploymentRecoveryDecision(repeatedPersistentDeployment), true, "repeated deployments retain the established generation");

const resetFresh = decideDeploymentRecovery({ ...input, persistentPreviouslyEstablished: true, resetSupersedesPersistentGeneration: true });
assert.equal(resetFresh.deploymentMode, "RESET_FRESH");
assert.equal(resetFresh.persistentState, "NONE");
assert.equal(resetFresh.deploymentAllowed, true);

const tags = { ManagedBy: "DeployGuard", DeployGuardProjectId: "project", Environment: "dev" };
const destructivePlan = JSON.stringify({ resource_changes: [{
  address: "aws_efs_file_system.database[0]",
  type: "aws_efs_file_system",
  change: { actions: ["delete", "create"], before: { tags }, after: { tags } },
}] });
const scope = { projectId: "project", environment: "dev" as const, infrastructureNamespace: "/deployguard/project" };
assert.equal(reviewGithubActionsTerraformPlan(destructivePlan, scope, { persistentState: "NONE", recoveryEvidenceAvailable: false }).safe, true,
  "incomplete fresh-generation resources may be reconciled without fake backup evidence");
assert.equal(reviewGithubActionsTerraformPlan(destructivePlan, scope, { persistentState: "PERSISTENT", recoveryEvidenceAvailable: false }).safe, false,
  "established persistent data remains protected");
assert.equal(reviewGithubActionsTerraformPlan(destructivePlan, scope, { persistentState: "PERSISTENT", recoveryEvidenceAvailable: true }).safe, true,
  "verified recovery evidence permits the protected plan");

const root = resolve(__dirname, "../..");
const deployment = readFileSync(resolve(root, "backend/src/projects/github-actions-deployment.service.ts"), "utf8");
const workflow = readFileSync(resolve(root, ".github/workflows/deployguard-reusable.yml"), "utf8");
const controller = readFileSync(resolve(root, "backend/src/projects/projects.controller.ts"), "utf8");
const ui = readFileSync(resolve(root, "frontend/src/components/projects/DatabaseTierSettings.jsx"), "utf8");
const projectApi = readFileSync(resolve(root, "frontend/src/api/projectApi.js"), "utf8");
assert.match(deployment, /retryOfOperationId: failed\.id[\s\S]*this\.dispatch/, "retry creates a new dispatch instead of rewriting the failed deploy attempt");
assert.match(deployment, /if \(action === "deploy" && !options\.expectedRetryInputs\)/,
  "an immutable retry never enters normal-deployment repository analysis refresh");
assert.doesNotMatch(deployment, /expectedRetryInputs\.commit_sha !== \(contract\.commitSha/,
  "a newer mutable detection contract cannot reject the failed attempt's immutable commit");
assert.match(deployment, /MAX\(CASE WHEN run\.metadata ->> 'attempt'.*CAST\(run\.metadata ->> 'attempt' AS integer\)/,
  "new attempts advance from the highest persisted attempt instead of the historical row count");
assert.match(projectApi, /deploy\/history`, \{ cache: "no-store" \}/,
  "the pipeline refresh cannot reuse cached attempt history after retry admission");
assert.match(deployment, /deploymentContext/);
assert.match(workflow, /\.deploymentContext\.deploymentMode/);
assert.match(workflow, /DESTRUCTIVE_PERSISTENT_COUNT/);
assert.match(workflow, /This deployment would replace or remove persistent application data/);
assert.doesNotMatch(workflow, /DATABASE_SECRET_PRESENT/, "secret presence is never workflow persistence evidence");
assert.doesNotMatch(workflow, /Managed database data is unavailable and no retained filesystem was found/, "the legacy secret-driven failure is removed");
const retainedReconciliation = workflow.slice(
  workflow.indexOf("reconcile_retained_database_efs()"),
  workflow.indexOf("reconcile_security_group()", workflow.indexOf("reconcile_retained_database_efs()")),
);
assert.doesNotMatch(retainedReconciliation, /DATABASE_SECRET|bindingStatus|failed attempt/i,
  "retained EFS verification does not independently infer persistence");
assert.doesNotMatch(workflow.slice(workflow.indexOf("MANAGED_DATABASE_ENABLED="), workflow.indexOf("reconcile_security_group()")), /reconcile_retained_database_efs/,
  "generation preparation never adopts project persistence into generation state");
assert.match(workflow, /projects\/\$PROJECT_ID\/\$ENVIRONMENT_NAME\/project\/terraform\.tfstate/,
  "managed persistence is isolated in the project-scoped Terraform state");
assert.match(controller, /Post\(":projectId\/deploy\/reset-fresh"\)/);
assert.match(ui, /Reset &amp; Deploy Fresh/);
assert.doesNotMatch(deployment.slice(deployment.indexOf("async retry("), deployment.indexOf("async destroy(")), /operation\.status = PipelineRunStatus\.QUEUED/,
  "deploy retry retains the failed attempt instead of mutating it");

const immutableRetryPlan: any = {
  planVersion: 2,
  detectorVersion: BUILD_PLAN_DETECTOR_VERSION,
  repositoryFullName: "owner/application",
  branch: "main",
  commitSha: "a".repeat(40),
  appRoot: ".",
  port: 3000,
  healthPath: "/health",
  dockerTemplate: "nextjs-ssr",
  runtimeType: "server",
  outputDirectory: null,
  dockerStrategy: "generated",
  environmentOwnership: [],
  // Retry consumes the exact same bounded component inventory that a newly
  // detected repository persists.  This fixture intentionally represents a
  // valid legacy-shaped, single-component plan rather than bypassing the
  // workflow contract with an incomplete object.
  components: [{
    id: "application",
    role: "application",
    root: ".",
    buildContext: ".",
    repositoryInstallRoot: ".",
    port: 3000,
    healthPath: "/health",
    outputDirectory: null,
    dockerTemplate: "nextjs-ssr",
  }],
  relationships: [],
};
const immutableRetryPlanInputs = {
  ...Object.fromEntries(GITHUB_ACTIONS_INPUT_NAMES.map((name) => [name, "fixture"])),
  deployment_action: "deploy",
  deployment_operation_id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
  project_id: "11111111-2222-4333-8444-555555555555",
  repository_full_name: "owner/application",
  repository_branch: "main",
  commit_sha: immutableRetryPlan.commitSha,
  build_plan_base64: Buffer.from(JSON.stringify(immutableRetryPlan), "utf8").toString("base64"),
  application_root: ".",
  app_port: "3000",
  health_check_path: "/health",
  container_profile: "nextjs-ssr",
  output_directory: "",
} as GithubActionsOperationInputs;
const retryPlanService: any = Object.create(GithubActionsDeploymentService.prototype);
assert.equal(retryPlanService.retryBuildPlan(immutableRetryPlanInputs, {
  repositoryFullName: "owner/application", targetBranch: "main",
}).commitSha, immutableRetryPlan.commitSha, "retry uses the failed attempt's valid immutable BuildPlan");
assert.throws(() => retryPlanService.retryBuildPlan({ ...immutableRetryPlanInputs, commit_sha: "b".repeat(40) }, {
  repositoryFullName: "owner/application", targetBranch: "main",
}), /immutable retry BuildPlan does not match/, "tampered retry identity is rejected locally");

async function verifyRetryHistory() {
  const projectId = "11111111-2222-4333-8444-555555555555";
  const failedId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const commit = "a".repeat(40);
  const generationId = "99999999-9999-4999-8999-999999999999";
  const values: Record<string, string> = Object.fromEntries(GITHUB_ACTIONS_INPUT_NAMES.map((name) => [name, "fixture"]));
  Object.assign(values, {
    deployment_action: "deploy",
    deployment_operation_id: failedId,
    project_id: projectId,
    repository_full_name: "owner/application",
    repository_branch: "main",
    commit_sha: commit,
  });
  const inputs = values as GithubActionsOperationInputs;
  const failed: any = {
    id: failedId,
    detectionProfileId: "dddddddd-eeee-4fff-8aaa-bbbbbbbbbbbb",
    projectId,
    generationId,
    repositoryFullName: "owner/application",
    targetBranch: "main",
    commitSha: commit,
    status: PipelineRunStatus.FAILED,
    metadata: {
      executionEngine: "github_actions",
      deploymentAction: "deploy",
      immutableDispatchInputs: inputs,
      immutableDispatchFingerprint: immutableDispatchFingerprint(inputs),
    },
  };
  const service: any = Object.create(GithubActionsDeploymentService.prototype);
  service.project = async () => ({ id: projectId, repositoryFullName: "owner/application", targetBranch: "main" });
  service.platformFoundation = () => ({});
  service.sharedPlatformFoundation = { assertActive: async () => undefined };
  service.withProjectLock = async (_projectId: string, work: (repository: unknown) => Promise<unknown>) => work({});
  service.reconcileActive = async () => null;
  service.latestRun = async () => failed;
  service.currentLiveRun = async () => null;
  service.deploymentGenerations = {
    requireActiveGeneration: async () => ({ id: generationId }),
    requireRetryableGeneration: async () => ({ id: generationId }),
    live: async () => null,
  };
  service.destroyLifecycles = { active: async () => null };
  service.operationContractException = (error: unknown) => error;
  let dispatchOptions: Record<string, unknown> | null = null;
  service.dispatch = async (_user: unknown, _projectId: string, _repository: unknown, action: string, _previous: string | null, options: Record<string, unknown>) => {
    assert.equal(action, "deploy");
    dispatchOptions = options;
    return { deployment: { state: "accepted", operation: { id: "new-attempt" } } };
  };
  await service.retry({ id: 7 }, projectId);
  assert.equal(failed.status, PipelineRunStatus.FAILED, "the failed attempt remains historical evidence");
  assert.equal(dispatchOptions?.retryOfOperationId, failedId);
  assert.equal(dispatchOptions?.requestedMode, "RETRY");
  assert.equal(dispatchOptions?.retryDetectionProfileId, failed.detectionProfileId);
  assert.equal(dispatchOptions?.generationId, generationId);
}

void verifyRetryHistory().then(() => {
  console.log("State-aware deployment recovery checks passed: fresh DB, failed-first retry, stale metadata, existing persistence, missing data with and without backup, repeated deploy, destructive protection and explicit reset-fresh.");
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
