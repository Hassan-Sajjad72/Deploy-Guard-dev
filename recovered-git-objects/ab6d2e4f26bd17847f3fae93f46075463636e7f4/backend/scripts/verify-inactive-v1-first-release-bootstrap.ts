import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { canonicalSha256 } from "../src/orchestration-contracts/contracts/canonical-json";
import { InactiveV1FirstReleaseBootstrapAdapter } from "../src/orchestration-contracts/worker-runtime/inactive-v1-first-release-bootstrap.adapter";
import {
  V1FirstReleaseBootstrapClient,
  V1FirstReleaseBootstrapInput,
  V1FirstReleaseBootstrapStore,
  V1FirstReleaseFence,
  V1FirstReleaseImageEvidence,
  V1FirstReleaseManifest,
} from "../src/orchestration-contracts/worker-runtime/inactive-v1-first-release-bootstrap.types";
import { V1EcsAppliedInfrastructureRevision } from "../src/orchestration-contracts/worker-runtime/inactive-v1-ecs-release-mutation.types";
import { V1HandlerSideEffectBoundary } from "../src/orchestration-contracts/worker-runtime/v1-handler-side-effect.types";

const projectId = "11111111-1111-4111-8111-111111111111";
const infrastructureManifestId = "22222222-2222-4222-8222-222222222222";
const intentId = "33333333-3333-4333-8333-333333333333";
const leaseId = "44444444-4444-4444-8444-444444444444";
const key = "a".repeat(64);
const digest = `sha256:${"b".repeat(64)}`;
const taskArn = "arn:aws:ecs:us-east-1:123456789012:task-definition/deployguard-app:1";
const serviceArn = "arn:aws:ecs:us-east-1:123456789012:service/deployguard-project/deployguard-app";

const desiredSpec = {
  region: "us-east-1", terraformTemplateVersion: "v1", network: { topology: "managed_vpc" as const, availabilityZoneCount: 1, publicSubnets: true, privateSubnets: false, natMode: "none" as const },
  registry: { managedEcrRepository: true, immutableTags: true, lifecyclePolicyHash: null }, ecsFoundation: { clusterMode: "dedicated_project" as const, serviceName: "deployguard-app", launchType: "fargate" as const, capacityProviders: ["FARGATE"] },
  ingress: { enabled: true, protocol: "HTTP" as const, containerPort: 8501, targetGroupPort: 8501, healthCheckPath: "/", healthCheckProtocol: "HTTP" as const },
  database: { mode: "none" as const, engine: null, tierRevision: null, persistence: false, externalTlsRequired: null }, storage: { efsRequired: false, accessPointRequired: false, encrypted: true, backupRequired: false }, discovery: { cloudMapRequired: false, namespace: null }, observability: { cloudWatchLogs: true, cloudWatchMetrics: true, prometheus: false }, iamPolicyRevision: "v1", tags: { managedBy: "DeployGuard" },
};
const outputs = {
  ecr_repository_url: "123456789012.dkr.ecr.us-east-1.amazonaws.com/deployguard-app", ecs_cluster_arn: "arn:aws:ecs:us-east-1:123456789012:cluster/deployguard-project", ecs_task_role_arn: "arn:aws:iam::123456789012:role/deployguard-task", ecs_execution_role_arn: "arn:aws:iam::123456789012:role/deployguard-execution", ecs_log_group_name: "/deployguard/project/app", alb_target_group_arn: "arn:aws:elasticloadbalancing:us-east-1:123456789012:targetgroup/deployguard-app/123", alb_dns_name: "deployguard.example.test", app_security_group_id: "sg-0123abc", public_subnet_ids: ["subnet-0123abc"], canary_ecs_assign_public_ip: true,
};
const infrastructure: V1EcsAppliedInfrastructureRevision = { id: infrastructureManifestId, schemaVersion: 1, projectId, environmentName: "dev", revision: "4", parentManifestId: null, createdByIntentId: null, createdByUserId: null, origin: "planner", status: "applied", specHash: canonicalSha256(desiredSpec), terraformTemplateVersion: "v1", stateBackend: "s3", stateKey: "projects/new/terraform.tfstate", desiredSpec, changeSet: { fromManifestId: null, changedPaths: [], categories: [], destructivePaths: [], requiresApproval: false, reasonCodes: [] }, requiresTerraform: true, terraformOutputs: outputs, terraformOutputsHash: canonicalSha256(outputs) };
const fence: V1FirstReleaseFence = { intentId, leaseId, workerId: "fixture-worker", fencingToken: "1" };

function input(): V1FirstReleaseBootstrapInput {
  const releaseSpec = { source: { repositoryFullName: "Hassan-Sajjad72/Project-Tst", branch: "main", commitSha: "c".repeat(40), appRoot: "." }, build: { dockerStrategy: "generated" as const, dockerTemplate: "python-streamlit", buildCommand: "pip install -r requirements.txt", outputDirectory: null, buildArgumentNames: [] }, runtime: { imageUri: null, imageDigest: null, command: null, containerPort: 8501, cpu: 256, memory: 512, plainVariableNames: [], secretReferenceNames: [], serviceBindingRevisions: [] }, health: { path: "/", expectedPort: 8501, gracePeriodSeconds: 30 } };
  return { identity: { projectId, environmentName: "dev", infrastructureManifestId, infrastructureRevision: "4", intentId, idempotencyKey: key, buildPushOperationId: "55555555-5555-4555-8555-555555555555", registerTaskDefinitionOperationId: "66666666-6666-4666-8666-666666666666", createServiceOperationId: "77777777-7777-4777-8777-777777777777" }, releaseDraft: { schemaVersion: 1, projectId, environmentName: "dev", infrastructureManifestId, parentManifestId: null, previousStableManifestId: null, deploymentContractId: null, configurationSnapshotId: null, origin: "planner", repositoryFullName: releaseSpec.source.repositoryFullName, branch: "main", commitSha: releaseSpec.source.commitSha, appRoot: ".", deploymentContractHash: "d".repeat(64), configurationFingerprint: "e".repeat(64), buildFingerprint: "f".repeat(64), runtimeFingerprint: "1".repeat(64), releaseSpec, specHash: canonicalSha256(releaseSpec) }, timeoutMs: 5000, execution: { signal: new AbortController().signal, isLeaseTrusted: () => true }, fence, sideEffects: undefined as unknown as V1HandlerSideEffectBoundary };
}

class Store implements V1FirstReleaseBootstrapStore {
  image: V1FirstReleaseImageEvidence | null = null; release: V1FirstReleaseManifest | null = null;
  async loadAppliedInfrastructure() { return infrastructure; }
  async loadImageProvenance() { return this.image; }
  async loadReleaseManifest() { return this.release; }
  async recordImageProvenance({ evidence }: any) { this.image ??= evidence; assert.deepEqual(this.image, evidence); return this.image; }
  async createOrReuseReleaseManifest({ release, evidence }: any) { if (!this.image) throw new Error("missing provenance"); if (!this.release) this.release = { id: randomUUID(), revision: "1", projectId, environmentName: "dev", infrastructureManifestId, imageUri: evidence.imageUri, imageDigest: evidence.imageDigest, releaseSpec: release.releaseSpec, taskDefinitionInputHash: null, taskDefinitionArn: null, initialServiceInputHash: null, initialServiceArn: null }; return this.release; }
  async recordTaskDefinition({ taskDefinitionInputHash, taskDefinitionArn }: any) { this.release!.taskDefinitionInputHash = taskDefinitionInputHash; this.release!.taskDefinitionArn = taskDefinitionArn; return this.release!; }
  async recordInitialService({ serviceInputHash, serviceArn }: any) { this.release!.initialServiceInputHash = serviceInputHash; this.release!.initialServiceArn = serviceArn; return this.release!; }
  async recordHealthyRelease() { return this.release!; }
}
class Client implements V1FirstReleaseBootstrapClient {
  readonly policy = "deployguard.first-release-bootstrap/client-v1" as const; pushes = 0; tasks = 0; services = 0; serviceState: "absent" | "present" | "ambiguous" = "absent";
  async buildAndPushImmutableImage() { this.pushes += 1; return { imageUri: outputs.ecr_repository_url, imageDigest: digest, commitSha: "c".repeat(40), buildFingerprint: "f".repeat(64) }; }
  async resolveImmutableImageEvidence() { return { imageUri: outputs.ecr_repository_url, imageDigest: digest, commitSha: "c".repeat(40), buildFingerprint: "f".repeat(64) }; }
  async inspectExactService() { return { state: this.serviceState }; }
  async registerInitialTaskDefinition() { this.tasks += 1; return { taskDefinitionArn: taskArn }; }
  async createInitialService() { this.services += 1; this.serviceState = "present"; return { serviceArn }; }
  async verifyInitialRelease() { return { safeCode: "FIRST_RELEASE_HEALTHY" as const, evidenceHash: "9".repeat(64), applicationUrl: "http://deployguard.example.test/" }; }
}
function boundary(): V1HandlerSideEffectBoundary {
  const effects = new Map<string, any>();
  return { finalizationStatus: () => ({ allowed: true, safeFailureCode: null }), execute: async (request) => {
    const current = effects.get(request.idempotencyKey); if (current) return { disposition: "replayed" as const, effect: current };
    const context: any = { ...fence, projectId, environmentName: "dev", operationId: request.operationId, idempotencyKey: request.idempotencyKey, effectType: request.effectType, inputFingerprint: request.inputFingerprint, signal: new AbortController().signal, deadlineAt: new Date(Date.now() + 5000), isLeaseTrusted: () => true };
    const outcome = await request.perform(context); const effect = { id: randomUUID(), ...context, requestFingerprint: request.inputFingerprint, status: outcome.outcome === "succeeded" ? "succeeded" : outcome.outcome, safeResultCode: (outcome as any).safeResultCode ?? null, resultFingerprint: (outcome as any).resultFingerprint ?? null, externalReferenceHash: (outcome as any).externalReferenceHash ?? null, failureCode: (outcome as any).safeFailureCode ?? null, reconciliationRequired: outcome.outcome === "uncertain", attemptStartedAt: new Date(), deadlineAt: context.deadlineAt, completedAt: new Date(), createdAt: new Date(), updatedAt: new Date() };
    effects.set(request.idempotencyKey, effect); return { disposition: "executed" as const, effect };
  } };
}

(async () => {
  const store = new Store(); const client = new Client(); const adapter = new InactiveV1FirstReleaseBootstrapAdapter(store, client); const request = input(); request.sideEffects = boundary();
  const first = await adapter.bootstrap(request);
  assert.equal(first.disposition, "initial_release_healthy"); assert.equal(client.pushes, 1); assert.equal(client.tasks, 1); assert.equal(client.services, 1); assert.equal(store.release?.imageDigest, digest);
  const replay = await adapter.bootstrap(request); assert.equal(replay.serviceArn, serviceArn); assert.equal(client.pushes, 1); assert.equal(client.tasks, 1); assert.equal(client.services, 1);
  const absentStore = new Store(); const occupied = new Client(); occupied.serviceState = "present"; const blocked = input(); blocked.sideEffects = boundary();
  await assert.rejects(() => new InactiveV1FirstReleaseBootstrapAdapter(absentStore, occupied).bootstrap(blocked), /FIRST_RELEASE_SERVICE_ALREADY_EXISTS/); assert.equal(occupied.pushes, 0); assert.equal(occupied.services, 0);
  assert.throws(() => require("../src/orchestration-contracts/worker-runtime/inactive-v1-first-release-bootstrap.pure").injectV1FirstReleaseImage({ ...request.releaseDraft, releaseSpec: { ...request.releaseDraft.releaseSpec, runtime: { ...request.releaseDraft.releaseSpec.runtime, imageUri: "image:latest" } } }, { imageUri: outputs.ecr_repository_url, imageDigest: digest, commitSha: "c".repeat(40), buildFingerprint: "f".repeat(64) }), /FIRST_RELEASE_DRAFT_MUST_NOT_CONTAIN_IMAGE/);
  console.log("Inactive v1 first-release bootstrap fixture verification passed.");
})().catch((error) => { console.error(error); process.exitCode = 1; });

const adapterSource = readFileSync(require.resolve("../src/orchestration-contracts/worker-runtime/inactive-v1-first-release-bootstrap.adapter"), "utf8");
assert.equal(/from\s+["'][^"']*(?:bullmq|terraform|@aws-sdk|aws-sdk)[^"']*["']/i.test(adapterSource), false, "bootstrap boundary must not import queue, Terraform, or an AWS SDK client");
