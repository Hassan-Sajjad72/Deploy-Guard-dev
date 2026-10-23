import { strict as assert } from "node:assert";
import { DeploymentCheckpointService } from "../src/projects/recovery/deployment-checkpoint.service";
import { DeploymentRecoveryPlanner } from "../src/projects/recovery/deployment-recovery-planner.service";

const planner = new DeploymentRecoveryPlanner(new DeploymentCheckpointService());
const cloud = {
  deploymentStatus: "not_deployed", healthStatus: "unknown", infrastructureStatus: "not_provisioned",
  resourceStatus: "no_cloud_resources_found", cleanupStatus: "not_requested", cloudVerificationStatus: "verified",
  inventoryStatus: "scanned", adminActionRequired: false, nextAction: "no_action", statusExplanation: "No issue.",
  lastCloudVerifiedAt: null, lastInventoryScanId: null, verificationTtlSeconds: 180, evidence: {},
};
function input(overrides: Record<string, unknown> = {}) {
  return {
    projectId: "11111111-1111-4111-8111-111111111111", repositoryFullName: "example/app", branch: "main",
    contract: null, preflight: null, run: null, events: [], scan: null, environment: null, lock: null,
    storage: null, deployment: null, databaseTier: null, cloudState: cloud, isDeploymentJobActive: false,
    ...overrides,
  } as any;
}
function code(overrides: Record<string, unknown>) { return planner.plan(input(overrides))?.code; }

assert.equal(code({ deployment: { id: "dep", status: "failed", errorMessage: "SequelizeConnectionRefusedError: connect ECONNREFUSED 127.0.0.1:5432", metadata: {}, failedAt: new Date() } }), "app_connected_to_localhost_database");
assert.equal(code({ contract: { blockers: ["Missing required environment variable DATABASE_URL"], missingEnvVars: ["DATABASE_URL"], buildTimeEnvVars: [], databaseRequired: false } }), "missing_runtime_env_vars");
assert.equal(code({ run: { id: "run", currentStage: "clone_repository", errorMessage: "Repository not found or permission denied" } }), "repo_private_access_failed");
assert.equal(code({ deployment: { id: "dep", status: "failed", errorMessage: "App is listening on port 8080, but ECS expected port 3000", metadata: {} } }), "wrong_port_binding");
assert.equal(code({ run: { id: "run", errorMessage: "Health check returned HTTP 404", currentStage: "alb_health" }, cloudState: { ...cloud, healthStatus: "unreachable" } }), "health_check_path_missing");
assert.equal(code({ run: { id: "run", errorMessage: "Docker build failed: npm ci exited 1", currentStage: "docker_build" } }), "dependency_install_failed");
assert.equal(code({ scan: { policyDecision: "blocked" } }), "critical_vulnerability_blocked");
assert.equal(code({ lock: { status: "stale" }, run: { id: "run", errorMessage: "Terraform state lock is stale", currentStage: "state_lock" } }), "state_lock_stuck");
assert.equal(code({ cloudState: { ...cloud, resourceStatus: "cleanup_required", cleanupStatus: "cleanup_required", nextAction: "clean_safe_leftovers", statusExplanation: "Verified project residue remains." } }), "safe_leftovers_available");
assert.equal(code({ cloudState: { ...cloud, inventoryStatus: "unavailable_auth_required" } }), "aws_permission_reauth_required");

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

const primary = planner.plan(input({ deployment: { id: "dep", status: "failed", errorMessage: "ECONNREFUSED 127.0.0.1:5432", metadata: {} }, cloudState: { ...cloud, healthStatus: "unreachable" } }));
assert.equal(primary?.code, "app_connected_to_localhost_database");
assert.equal(primary?.primaryActionRoute.includes("/requirements?focus=database"), true);
assert.equal(primary?.developerDetails && "secret" in primary.developerDetails, false);

console.log("Deployment recovery taxonomy, priority, directed routing, and checkpoint verification passed.");
