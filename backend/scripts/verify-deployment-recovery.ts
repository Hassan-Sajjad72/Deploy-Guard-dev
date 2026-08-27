import { strict as assert } from "node:assert";
import { DeploymentCheckpointService } from "../src/projects/recovery/deployment-checkpoint.service";
import { DatabaseRequirementAnalyzer } from "../src/projects/recovery/database-requirement-analyzer.service";
import { DeploymentRecoveryPlanner } from "../src/projects/recovery/deployment-recovery-planner.service";
import { EcsDiagnosticsClassifier } from "../src/projects/recovery/ecs-diagnostics-classifier.service";
import { PreflightIssueMapper } from "../src/projects/recovery/preflight-issue-mapper.service";
import { StorageRequirementAnalyzer } from "../src/projects/recovery/storage-requirement-analyzer.service";

const planner = new DeploymentRecoveryPlanner(
  new DeploymentCheckpointService(),
  new PreflightIssueMapper(),
  new EcsDiagnosticsClassifier(),
  new DatabaseRequirementAnalyzer(),
  new StorageRequirementAnalyzer(),
);
const cloud = {
  deploymentStatus: "not_deployed", healthStatus: "unknown", infrastructureStatus: "not_provisioned",
  resourceStatus: "no_cloud_resources_found", cleanupStatus: "not_requested", cloudVerificationStatus: "verified",
  inventoryStatus: "scanned", adminActionRequired: false, nextAction: "no_action", statusExplanation: "No issue.",
  lastCloudVerifiedAt: null, lastInventoryScanId: null, verificationTtlSeconds: 180, evidence: {},
  terraformStatePresent: false, terraformStateSerial: null, terraformResourceCount: 0,
  terraformApplyStarted: false, terraformApplyCompleted: false, currentRunCreatedResources: false,
  currentRunModifiedResources: false, existingDeploymentPresent: false, existingDeploymentRunId: null,
  existingDeploymentReachable: null, orphanCandidates: [], verifiedResidue: [], unknownResources: [],
  cleanupRequiredForCurrentRun: false, projectCleanupRecommended: false, nextSafeAction: "no_action", reconciliationReason: "No issue.",
};
const stateSafety = {
  stateStatus: "missing", lockStatus: "none", lockId: null, heartbeatAt: null, releasedAt: null,
  validationStatus: "not_validated", validatedAt: null, stateVersionId: null, resourceCount: null,
  queueActive: false, activePipelineRunId: null, recoveryRequired: false, authoritativeTimestamp: null,
  supersedesHistoricalFailuresAt: null, sources: {}, currentStateInvalidation: { generation: 0, invalidatedAt: null, reason: null },
};
function input(overrides: Record<string, unknown> = {}) {
  return {
    projectId: "11111111-1111-4111-8111-111111111111", repositoryFullName: "example/app", branch: "main",
    contract: null, preflight: null, run: null, events: [], scan: null, cost: null, environment: null, lock: null,
    storage: null, deployment: null, databaseTier: null, cloudState: cloud, isDeploymentJobActive: false, stateSafety,
    ...overrides,
  } as any;
}
function code(overrides: Record<string, unknown>) { return planner.plan(input(overrides))?.code; }

assert.equal(code({ deployment: { id: "dep", status: "failed", errorMessage: "SequelizeConnectionRefusedError: connect ECONNREFUSED 127.0.0.1:5432", metadata: {}, failedAt: new Date() } }), "app_connected_to_localhost_database");
assert.equal(code({ deployment: { id: "dep", status: "failed", errorMessage: "ECS service failed", metadata: {} }, events: [{ status: "failed", message: "ECS task stopped", metadata: { ecsDiagnostics: { summary: "SequelizeConnectionRefusedError", logLines: ["connect ECONNREFUSED 127.0.0.1:5432"] } } }] }), "app_connected_to_localhost_database");
assert.equal(code({ contract: { blockers: ["Missing required environment variable DATABASE_URL"], missingEnvVars: ["DATABASE_URL"], buildTimeEnvVars: [], databaseRequired: false } }), "missing_runtime_env_vars");
assert.equal(code({ run: { id: "run", currentStage: "clone_repository", errorMessage: "Repository not found or permission denied" } }), "repo_private_access_failed");
assert.equal(code({ deployment: { id: "dep", status: "failed", errorMessage: "App is listening on port 8080, but ECS expected port 3000", metadata: {} } }), "wrong_port_binding");
assert.equal(code({ run: { id: "run", errorMessage: "Health check returned HTTP 404", currentStage: "alb_health" }, cloudState: { ...cloud, healthStatus: "unreachable" } }), "application_health_failed");
assert.equal(code({ run: { id: "run", errorMessage: "Docker build failed: npm ci exited 1", currentStage: "docker_build" } }), "dependency_install_failed");
assert.equal(code({ scan: { policyDecision: "blocked" } }), "critical_vulnerability_blocked");
assert.equal(code({
  lock: { status: "stale" },
  run: { id: "run", errorMessage: "Terraform state lock is stale", currentStage: "state_lock" },
  stateSafety: { ...stateSafety, lockStatus: "stale", recoveryRequired: true },
}), "state_lock_stuck");
assert.equal(code({ cloudState: { ...cloud, resourceStatus: "cleanup_required", cleanupStatus: "cleanup_required", nextAction: "clean_safe_leftovers", nextSafeAction: "clean_verified_residue", projectCleanupRecommended: true, statusExplanation: "Verified project residue remains." } }), "safe_leftovers_available");
assert.equal(code({ cloudState: { ...cloud, inventoryStatus: "unavailable_auth_required" } }), "aws_permission_reauth_required");
assert.equal(code({ run: { id: "run", errorMessage: "Authentication required. Please sign in again." } }), "authentication_required");
assert.equal(code({ run: { id: "run", errorMessage: "GitHub token expired while cloning repository" } }), "github_token_expired");
assert.equal(code({ contract: { blockers: [], confidence: "low" } }), "low_confidence_detection");
assert.equal(code({ contract: { blockers: ["Unsupported repository structure: no supported web application was found"] } }), "unsupported_repo_structure");
assert.equal(code({ contract: { blockers: ["Invalid env value for PORT"], missingEnvVars: [], buildTimeEnvVars: [] } }), "invalid_env_value");
assert.equal(code({ contract: { blockers: [], databaseRequired: true }, databaseTier: { provider: "managed", status: "pending", lastError: "DB_HOST points to localhost and is not reachable from ECS" } }), "database_localhost_config");
assert.equal(code({ contract: { blockers: [], databaseRequired: true }, databaseTier: { provider: "managed", status: "unhealthy", lastError: "Database service unhealthy" } }), "managed_service_not_ready");
assert.equal(code({ contract: { blockers: [], databaseRequired: true }, databaseTier: { provider: "managed", status: "unhealthy", lastError: "Database EFS mount failed" } }), "managed_service_not_ready");
assert.equal(code({ contract: { blockers: [], persistentStorageRequired: true } }), "file_storage_required_but_not_configured");
assert.equal(code({ run: { id: "run", errorMessage: "Persistent data delete confirmation required", currentStage: "cleanup_inventory" } }), "persistent_data_delete_confirmation_required");
assert.equal(code({ run: { id: "run", errorMessage: "Dockerfile generation failed", currentStage: "template_generation" } }), "dockerfile_generation_failed");
assert.equal(code({ run: { id: "run", errorMessage: "ECR push failed", currentStage: "ecr_push" } }), "ecr_push_failed");
assert.equal(code({ run: { id: "run", errorMessage: "Unsafe Dockerfile requests privileged container" } }), "unsafe_dockerfile");
assert.equal(code({ run: { id: "run", errorMessage: "Terraform apply failed while creating NAT gateway" } }), "nat_gateway_failure");
assert.equal(code({ deployment: { id: "dep", status: "failed", errorMessage: "ResourceInitializationError: secret injection failed", metadata: {} } }), "secrets_injection_failed");
assert.equal(code({ run: { id: "run", errorMessage: "Health check timeout", currentStage: "alb_health" }, cloudState: { ...cloud, healthStatus: "unreachable" } }), "application_health_failed");
assert.equal(code({ run: { id: "run", metadata: { failureClass: "database_service_unhealthy" }, errorMessage: "Database service unhealthy", currentStage: "database_service_readiness_failed" } }), "managed_service_not_ready");
assert.equal(code({ run: { id: "run", metadata: { failureClass: "health_check_timeout" }, errorMessage: "Health check timeout", currentStage: "alb_health" }, cloudState: { ...cloud, healthStatus: "unreachable" } }), "application_health_failed");
assert.equal(code({ cost: { status: "blocked_by_tier_limit", errorMessage: null, upgradePromptMessage: "Budget exceeded" } }), "budget_exceeded");
assert.equal(code({ cloudState: { ...cloud, resourceStatus: "cleanup_required", cleanupStatus: "cleanup_required", projectCleanupRecommended: true, statusExplanation: "Project TTL expired and resources remain." } }), "ttl_expired");
assert.equal(code({ run: { id: "run", metadata: { failureClass: "contract_invalid" }, errorMessage: "Deployment contract is invalid before infrastructure planning." } }), "contract_invalid");
assert.equal(code({ run: { id: "run", metadata: { failureClass: "plan_policy_failed" }, errorMessage: "Terraform plan task-definition policy failed." } }), "plan_policy_failed");
assert.equal(code({
  run: { id: "bb4a2769-2305-4617-bb20-d67acc4596e7", metadata: {}, errorMessage: "DB_PASSWORD does not use the binding secret reference." },
  databaseServiceBinding: { id: "binding", status: "ready", hostReference: "db.private", provider: "managed" },
  cloudState: { ...cloud, infrastructureStatus: "provisioned", terraformApplyCompleted: true },
}), "managed_database_binding_invalid");

const staleConfiguration = planner.plan(input({
  run: { id: "run", status: "failed", currentStage: "terraform_apply_approval_queued", errorMessage: "Project configuration changed after this pipeline run was queued." },
  cloudState: { ...cloud, infrastructureStatus: "provisioned", resourceStatus: "active_resources", terraformStatePresent: true, terraformResourceCount: 152, existingDeploymentPresent: true },
}));
assert.equal(staleConfiguration?.code, "project_configuration_changed");
assert.equal(staleConfiguration?.primaryActionLabel, "Generate a new Terraform plan");
assert.equal(staleConfiguration?.resumeFromStage, "terraform_plan");
assert.equal(staleConfiguration?.category, "terraform");
assert.equal(staleConfiguration?.developerDetails?.cleanupRequiredForCurrentRun, false);

const staleCachedMutationEvidence = planner.plan(input({
  run: { id: "run", status: "failed", currentStage: "terraform_apply_approval_queued", errorMessage: "The deployment contract changed after planning. Generate a new plan." },
  events: [{ stage: "terraform_apply_gate", status: "waiting_approval", message: "Approval required.", createdAt: new Date() }],
  cloudState: { ...cloud, terraformApplyStarted: true, infrastructureStatus: "provisioned", resourceStatus: "active_resources" },
}));
assert.equal(staleCachedMutationEvidence?.code, "project_configuration_changed");
assert.equal(staleCachedMutationEvidence?.resumeFromStage, "terraform_plan");
assert.equal(staleCachedMutationEvidence?.developerDetails?.cleanupRequiredForCurrentRun, false);

assert.equal(code({
  run: { id: "run", status: "failed", currentStage: "terraform_apply_approval_queued", errorMessage: "Project configuration changed after this pipeline run was queued." },
  cloudState: { ...cloud, resourceStatus: "cleanup_required", cleanupStatus: "cleanup_required", projectCleanupRecommended: false },
}), "project_configuration_changed");

const runtime = new DeploymentCheckpointService().plan("missing_runtime_env_vars");
assert.equal(runtime.resumeFromStage, "ecs_task_definition");
assert.equal(runtime.requiresFullRerun, false);
assert.equal(runtime.affectedStages.includes("docker_build"), false);
const database = new DeploymentCheckpointService().plan("database_service_unhealthy");
assert.equal(database.resumeFromStage, "database_tier_setup");
assert.equal(database.requiresFullRerun, false);
const health = new DeploymentCheckpointService().plan("health_check_path_missing");
assert.equal(health.resumeFromStage, "alb_health");
assert.equal(health.affectedStages.includes("docker_build"), false);
const source = new DeploymentCheckpointService().plan("branch_not_found");
assert.equal(source.resumeFromStage, "repo_clone");
assert.equal(source.requiresFullRerun, true);
const cost = new DeploymentCheckpointService().plan("cost_gate_blocked");
assert.equal(cost.resumeFromStage, "terraform_apply");
assert.equal(cost.affectedStages.includes("docker_build"), false);
const persistentDelete = new DeploymentCheckpointService().plan("persistent_data_delete_confirmation_required");
assert.equal(persistentDelete.resumeFromStage, "cleanup_inventory");
assert.equal(persistentDelete.canResume, false);
const changedConfiguration = new DeploymentCheckpointService().plan("project_configuration_changed");
assert.equal(changedConfiguration.resumeFromStage, "terraform_plan");
assert.equal(changedConfiguration.affectedStages.includes("docker_build"), false);
const contractRepair = new DeploymentCheckpointService().plan("contract_invalid");
assert.equal(contractRepair.resumeFromStage, "terraform_plan");
assert.equal(contractRepair.affectedStages.includes("docker_build"), false);

const primary = planner.plan(input({ deployment: { id: "dep", status: "failed", errorMessage: "ECONNREFUSED 127.0.0.1:5432", metadata: {} }, cloudState: { ...cloud, healthStatus: "unreachable" } }));
assert.equal(primary?.code, "app_connected_to_localhost_database");
assert.equal(primary?.primaryActionRoute.includes("/requirements?focus=database"), true);
assert.equal(primary?.developerDetails && "secret" in primary.developerDetails, false);
assert.equal(primary?.title, "Database setup required");
assert.equal(primary?.rootCause, "The app is trying to connect to PostgreSQL at 127.0.0.1:5432 inside the app container.");
assert.equal(primary?.simpleExplanation, "In cloud deployment, localhost means inside the app container, not the database service.");
assert.equal(primary?.primaryActionLabel, "Configure database");
assert.equal(primary?.focusSection, "database_setup");
assert.equal(primary?.resumeFromStage, "database_tier_setup");
assert.equal(primary?.canResume, true);
assert.equal(primary?.requiresFullRerun, false);

console.log("Deployment recovery taxonomy, priority, directed routing, and checkpoint verification passed.");
