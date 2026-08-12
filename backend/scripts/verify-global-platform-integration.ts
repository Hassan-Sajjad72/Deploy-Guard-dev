import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { managedDatabaseEfsCreationToken, MANAGED_DATABASE_PERSISTENCE_TAG } from "../src/projects/managed-database-identity";

const root = resolve(__dirname, "../..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");
const workflow = read(".github/workflows/deployguard-reusable.yml");
const reconciliation = read("backend/src/projects/managed-database-reconciliation.service.ts");
const currentState = read("backend/src/projects/current-state/project-current-state.service.ts");
const generation = read("backend/src/projects/deployment-generation.service.ts");
const extinction = read("backend/src/projects/project-extinction.service.ts");
const retention = read("backend/src/projects/generation-retention.service.ts");
const deployment = read("backend/src/projects/github-actions-deployment.service.ts");
const migration = read("backend/src/migrations/1760000067000-GenerationResidueIsolation.ts");
const notifications = read("backend/src/notifications/sns-notification.adapter.ts");
const ai = read("backend/src/ai-troubleshooting/ai-evidence-preprocessor.service.ts");
const aiProvider = read("backend/src/ai-troubleshooting/ai-provider.adapter.ts");
const auth = read("backend/src/auth/auth.service.ts");
const middleware = read("backend/src/common/middleware/authenticated-user.middleware.ts");
const routes = read("frontend/src/routes/AppRoutes.jsx");
const sidebar = read("frontend/src/components/layout/Sidebar.jsx");
const contract = read("backend/src/projects/deployment-contract.service.ts");
const projectsModule = read("backend/src/projects/projects.module.ts");
const stateModule = read("backend/src/state-management/state-management.module.ts");

const projectId = "9ffe6827-f55a-4469-ac80-64530f8cea2e";
const generationA = "404cd3c1-a7dd-4b26-85e9-f531b3cb7ef1";
const generationB = "f0c70050-8d95-4fa4-ba2e-49465e950a39";
const tokenA = managedDatabaseEfsCreationToken(projectId, "dev", generationA);
assert.ok(tokenA.length <= 64);
assert.equal(tokenA, managedDatabaseEfsCreationToken(projectId, "dev", generationA));
assert.notEqual(tokenA, managedDatabaseEfsCreationToken(projectId, "dev", generationB));
assert.equal(MANAGED_DATABASE_PERSISTENCE_TAG, "generation");
assert.match(workflow, /creation_token = "dg-efs-\$\{substr\(replace\(lower\(var\.project_id\), "_", "-"\), 0, 8\)\}-\$\{substr\(replace\(lower\(var\.environment_name\), "_", "-"\), 0, 8\)\}-\$\{substr\(sha256\(join\(":"/);
assert.match(reconciliation, /managedDatabaseEfsCreationToken/);
assert.match(reconciliation, /MANAGED_DATABASE_PERSISTENCE_TAG/);

assert.match(deployment, /status IN \(:\.\.\.statuses\)/);
assert.match(deployment, /run\.generationId = :generationId/);
assert.match(currentState, /status: StableReleaseStatus\.STABLE/);
assert.match(currentState, /DeployGuardGenerationId === generationId/);
assert.match(currentState, /DescribeImagesCommand\(\{ repositoryName: repository, imageIds: \[imageId\] \}\)/);
assert.match(currentState, /service\.taskDefinition !== release\.taskDefinitionArn/);

assert.match(migration, /legacy_generation_unproven/);
assert.match(migration, /application_storage_not_supported_by_active_workflow/);
assert.match(migration, /status = 'superseded'/);
assert.match(migration, /encrypted_secret_payload = NULL/);
assert.match(generation, /retirementEvidence: "verified_destroyed"/);
assert.match(generation, /encryptedSecretPayload: null/);
assert.match(generation, /databaseServiceBindingId: null, configurationSnapshotId: null/);
assert.match(workflow, /terraformStateVersionsAbsent:true/);
assert.match(workflow, /projectOwnedAwsResourcesAbsent:true/);
assert.match(workflow, /allProjectTerraformArtifactsAbsent:true/);
assert.match(workflow, /list-object-versions/);
assert.match(workflow, /delete_generation_image_repository/);
assert.match(workflow, /project_task_definitions_absent/);
assert.match(extinction, /DESTROY_INCOMPLETE/);
assert.match(extinction, /getRepository\(Project\)\.delete\(\{ id: projectId \}\)/);
assert.match(extinction, /database traces remain/);
assert.match(deployment, /extinction\.extinguish\(project, saved, credential\.token, async \(phase\) =>/);
assert.match(deployment, /destroyLifecycles\.phase\(project\.id, environmentName, saved\.id, phase\)/);
assert.doesNotMatch(deployment, /retireAfterVerifiedDestroy\(operation\.generationId, operation\.id\)/);

assert.ok(workflow.includes(".imageDetails | sort_by(.imagePushedAt) | reverse | .[20:120][]?"));
assert.match(workflow, /OLD_TASK_DEFINITIONS/);
assert.match(deployment, /retentionProtectedRelease:\s*\{[\s\S]*imageDigests:[\s\S]*taskDefinitionArns:/);
assert.match(deployment, /deployedByPipelineRunId: previousStableOperationId/);
assert.match(workflow, /PROTECTED_IMAGE_DIGESTS=.*retentionProtectedRelease\.imageDigests/);
assert.match(workflow, /select\(\.imageDigest as \$digest \| \(\$protected \| index\(\$digest\)\) == null\)/);
assert.match(workflow, /PROTECTED_TASK_DEFINITIONS=.*retentionProtectedRelease\.taskDefinitionArns/);
assert.match(workflow, /\$protected \| index\(\$arn\) != null/);
assert.match(retention, /CONFIGURATION_SECRET_WINDOW = 20/);
assert.match(retention, /status IN \('stable', 'rollback_target'\)/);
assert.match(retention, /status IN \('queued', 'running'\)/);

assert.match(workflow, /deployguard-cost-plan\.json/);
assert.match(projectsModule, /GithubActionsCostEvidenceService/);
assert.match(currentState, /source: CostEstimateSource\.INFRACOST/);
assert.match(currentState, /generationId: projected\.latestAttempt\.generationId/);

assert.match(projectsModule, /NotificationsModule/);
assert.match(notifications, /deployguardProjectId/);
assert.match(notifications, /GetSubscriptionAttributesCommand/);
assert.match(deployment, /notifications\.dispatch/);

assert.match(aiProvider, /systemInstruction/);
assert.match(aiProvider, /DeployGuard's evidence-bound incident assistant/);
assert.match(ai, /evidenceReferences/);
assert.match(ai, /allowedEvidence/);
assert.match(ai, /references\.some\(\(reference\) => !allowed\.has/);

assert.match(auth, /deploy_guard_admin_session/);
assert.match(auth, /audience: "developer" \| "admin"/);
assert.match(auth, /Administrator accounts must use the separate admin login/);
assert.match(middleware, /adminRoute \? ADMIN_SESSION_COOKIE_NAME : SESSION_COOKIE_NAME/);
assert.match(routes, /path="\/admin\/login"|path="\/admin\/login"/);
assert.match(routes, /AdminProtectedRoute/);
assert.doesNotMatch(sidebar, /\/admin/);

assert.match(contract, /Application file-system persistence is not supported by the active GitHub Actions deployment engine/);
assert.match(projectsModule, /AwsCliModule/);
assert.doesNotMatch(projectsModule, /StateManagementModule/);
assert.match(stateModule, /AwsCliModule/);

console.log("Global platform integration checks passed: generation identity/authority, legacy quarantine, verified Destroy, bounded retention, cost, notifications, evidence-bound AI, Admin separation, and retired mutation boundaries.");
