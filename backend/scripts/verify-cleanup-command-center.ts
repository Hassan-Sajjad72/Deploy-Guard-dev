import { strict as assert } from "node:assert";
import { InfrastructureLifecycleService } from "../src/infrastructure-lifecycle/infrastructure-lifecycle.service";
import { EmergencyCleanupService } from "../src/infrastructure-lifecycle/emergency-cleanup.service";
import { CLEANUP_QUEUE_NAME, EMERGENCY_CLEANUP_QUEUE_NAME } from "../src/infrastructure-lifecycle/lifecycle.queue";
import { InfrastructureEnvironmentType } from "../src/infrastructure/project-infrastructure-environment.entity";

const projectId = "7672125f-f3b1-42e5-861c-455c0f722896";
const lifecycle = Object.create(InfrastructureLifecycleService.prototype) as any;
const groups = lifecycle.groupResources([
  { id: "vpc", name: "vpc", category: "vpc", cleanupEligibility: "terraform_destroy", deleteStatus: "active" },
  { id: "repo", name: "deployguard/repo", category: "ecr_repository", cleanupEligibility: "safe_cleanup", deleteStatus: "active", resourceKey: "ecr:repo" },
  { id: "image", name: "deployguard/repo:latest", category: "ecr_image", cleanupEligibility: "manual_review", deleteStatus: "active", resourceKey: "ecr:repo:image" },
  { id: "state", name: "terraform.tfstate", category: "terraform_state", cleanupEligibility: "protected", protected: true, deleteStatus: "protected" },
]);
assert.equal(groups.terraformStack.count, 1);
assert.equal(groups.directCleanup.ecrRepositories[0].children.length, 1);
assert.equal(groups.protected.length, 1);

const environmentRepository = { find: async () => [
  { id: "test-env", projectId, environmentName: "dev", environmentType: InfrastructureEnvironmentType.TESTING, updatedAt: new Date() },
  { id: "prod-env", projectId: "7672125f-f3b1-42e5-861c-455c0f722899", environmentName: "production", environmentType: InfrastructureEnvironmentType.PRODUCTION, updatedAt: new Date() },
] };
const resourceRepository = { find: async () => [
  { projectId, status: "active", protected: false, ownership: "project_owned", tags: { ManagedBy: "DeployGuard", Environment: "dev" }, costRisk: "high" },
  { projectId, status: "active", protected: false, ownership: "project_owned", tags: { Environment: "dev" }, costRisk: "low" },
] };
const projectRepository = { find: async () => [{ id: projectId, name: "Testing project" }] };
const emergency = new EmergencyCleanupService({} as any, environmentRepository as any, resourceRepository as any, projectRepository as any, {} as any, {} as any, {} as any);
emergency.preview().then((preview) => {
  assert.equal(preview.targetCount, 1);
  assert.equal(preview.targets[0].projectId, projectId);
  assert.equal(preview.productionExcluded, true);
  assert.notEqual(CLEANUP_QUEUE_NAME, EMERGENCY_CLEANUP_QUEUE_NAME);
  console.log("Cleanup command center verification passed: grouping, strict non-production selection, and separate queues are valid.");
}).catch((error) => { console.error(error); process.exitCode = 1; });
