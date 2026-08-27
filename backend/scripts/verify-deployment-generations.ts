import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { generationCleanupTarget } from "../src/projects/generation-cleanup-policy";
import { managedDatabaseEfsCreationToken } from "../src/projects/managed-database-identity";

const root = resolve(__dirname, "../..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");
const deployment = read("backend/src/projects/github-actions-deployment.service.ts");
const lifecycle = read("backend/src/projects/deployment-generation.service.ts");
const migration = read("backend/src/migrations/1760000072000-NoConflictGenerationArchitecture.ts");
const bindings = read("backend/src/infrastructure/database-service-binding.service.ts");
const secrets = read("backend/src/projects/github-actions-runtime-secret.service.ts");
const workflow = read(".github/workflows/deployguard-reusable.yml");

assert.match(deployment, /createCandidate\(projectId, environmentName/, "normal Deploy creates a new generation");
assert.match(deployment, /requireRetryableGeneration/, "Retry reuses the immutable failed candidate generation");
assert.match(deployment, /promoteVerified\(operation\.generationId/, "verified release ingestion promotes the exact candidate");
assert.match(deployment, /markFailed\([\s\S]*saved\.generationId/, "failed verification marks only the candidate FAILED");
assert.match(deployment, /failCandidateBeforeDispatch\([\s\S]*generation\.id[\s\S]*requestedMode: "DEPLOY"/, "normal Deploy records terminal preparation failures against the persisted candidate operation");
assert.match(deployment, /requestedMode: "RESET_FRESH"/, "Reset-Fresh records terminal preparation failures against the persisted candidate operation");
assert.match(deployment, /retryOfOperationId: failed\.id[\s\S]*failCandidateBeforeDispatch/, "Retry records terminal preparation failures against its new immutable operation");
assert.match(lifecycle, /route\?\.candidateGenerationId === generation\.id[\s\S]*route\.candidateGenerationId = null/, "candidate terminal failure clears only the matching route candidate identity");
assert.match(lifecycle, /generation-promote:[\s\S]*previous\.status[\s\S]*candidate\.status = DeploymentGenerationStatus\.LIVE/, "promotion retires old LIVE transactionally");
assert.match(lifecycle, /allocateCandidateListenerPriority[\s\S]*deployguard-candidate-listener-priority-allocation/, "every candidate receives a globally collision-free listener priority");
assert.match(lifecycle, /Keep historical allocations reserved/, "a retired generation's routing identity remains reserved until its generation cleanup completes");
assert.ok(
  deployment.indexOf("await this.verifyAndPersistStableRelease(operation, releaseEvidence)")
    < deployment.indexOf("await this.scheduleRetiredGenerationCleanup(project, operation, credential.token)"),
  "retired cleanup is scheduled only after authoritative LIVE finalization commits",
);
assert.match(deployment, /internalMaintenance: true/, "retired cleanup is persisted as a non-release maintenance operation");
assert.match(deployment, /detectionProfileId: null,[\s\S]*internalMaintenance: true/, "retired cleanup does not copy a mutable or stale detection-profile association");
assert.match(deployment, /COALESCE\(run\.metadata ->> 'internalMaintenance', 'false'\) != 'true'/, "maintenance cleanup cannot block a later developer deployment");
assert.match(deployment, /retryPendingGenerationCleanup[\s\S]*retryAfterMs = 5 \* 60 \* 1_000/, "retired and failed-candidate cleanup debt has bounded independent retry scheduling");
assert.match(workflow, /if: inputs\.deployment_action == 'cleanup'/, "the reusable workflow has an explicit independent exact-generation cleanup action");
assert.doesNotMatch(workflow, /Clean exact generation independently[\s\S]*?if: \$\{\{ false \}\}/, "generation cleanup is not hard-disabled");
assert.match(lifecycle, /generation-candidate:[\s\S]*UQ_project_deployment_generation_candidate|generation_candidate_exists/, "only one candidate is admitted");
assert.match(migration, /UQ_project_deployment_generation_live/);
assert.match(migration, /UQ_project_environment_route_priority/);
assert.match(migration, /terraform_state_key/);
assert.match(bindings, /generationId: null/, "database binding is project scoped");
assert.doesNotMatch(secrets, /\$\{generationId\}\/application\/runtime/, "runtime secret is project scoped");
assert.match(workflow, /platformFoundation\.ecsClusterArn/, "generation service uses the shared cluster");
assert.match(workflow, /platformFoundation\.listenerArn/, "generation route uses the shared listener");
assert.doesNotMatch(workflow, /resource "aws_ecs_cluster" "app"/, "generation Terraform cannot create the shared cluster");
assert.doesNotMatch(workflow, /resource "aws_lb" "app"/, "generation Terraform cannot create the shared ALB");
assert.match(workflow, /projects\/\$PROJECT_ID\/\$ENVIRONMENT_NAME\/\$GENERATION_ID\/terraform\.tfstate/);
assert.match(workflow, /DeployGuardGenerationId/);
assert.match(workflow, /DeployGuardScope,Value=project/);

const project = "9ffe6827-f55a-4469-ac80-64530f8cea2e";
const token = managedDatabaseEfsCreationToken(project, "dev");
assert.ok(token.length <= 64);
assert.equal(token, managedDatabaseEfsCreationToken(project, "dev"));
assert.notEqual(token, managedDatabaseEfsCreationToken("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", "dev"));

const generation = "11111111-1111-4111-8111-111111111111";
const cleanup = generationCleanupTarget({
  projectId: project,
  environmentName: "dev",
  generationId: generation,
  terraformStateKey: `projects/${project}/dev/${generation}/terraform.tfstate`,
  resourceManifest: { ecsServiceArn: "arn:service", targetGroupArn: "arn:target" },
});
assert.deepEqual(Object.keys(cleanup.resources).sort(), ["ecsServiceArn", "targetGroupArn"]);
assert.throws(() => generationCleanupTarget({
  projectId: project,
  environmentName: "dev",
  generationId: generation,
  terraformStateKey: `projects/${project}/dev/${generation}/terraform.tfstate`,
  resourceManifest: { albArn: "arn:shared" },
}), /forbidden albArn/);
assert.throws(() => generationCleanupTarget({
  projectId: project,
  environmentName: "dev",
  generationId: generation,
  terraformStateKey: `projects/${project}/dev/other/terraform.tfstate`,
  resourceManifest: {},
}), /state identity mismatch/);

console.log("No-conflict generation static and cleanup-boundary checks passed.");
