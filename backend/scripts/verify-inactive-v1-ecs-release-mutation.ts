import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { canonicalSha256 } from "../src/orchestration-contracts/contracts/canonical-json";
import {
  assertV1EcsReleaseMutationIdentity,
  buildV1EcsReleaseMutationPlan,
  deriveV1EcsReleaseEffectIdempotencyKey,
} from "../src/orchestration-contracts/worker-runtime/inactive-v1-ecs-release-mutation.pure";
import {
  V1EcsReleaseManifestPair,
} from "../src/orchestration-contracts/worker-runtime/inactive-v1-ecs-release-mutation.types";

const projectId = "11111111-1111-4111-8111-111111111111";
const infrastructureManifestId = "22222222-2222-4222-8222-222222222222";
const releaseManifestId = "33333333-3333-4333-8333-333333333333";
const configurationSnapshotId = "44444444-4444-4444-8444-444444444444";
const mutationKey = "d".repeat(64);
const imageDigest = `sha256:${"e".repeat(64)}`;
const clusterArn =
  "arn:aws:ecs:us-east-1:123456789012:cluster/deployguard-project";
const serviceArn =
  "arn:aws:ecs:us-east-1:123456789012:service/deployguard-project/deployguard-app";
const taskDefinitionArn =
  "arn:aws:ecs:us-east-1:123456789012:task-definition/deployguard-app:7";

function pair(): V1EcsReleaseManifestPair {
  const desiredSpec = {
    region: "us-east-1",
    terraformTemplateVersion: "v1",
    network: {
      topology: "managed_vpc" as const,
      availabilityZoneCount: 2,
      publicSubnets: true,
      privateSubnets: true,
      natMode: "single" as const,
    },
    registry: {
      managedEcrRepository: true,
      immutableTags: true,
      lifecyclePolicyHash: null,
    },
    ecsFoundation: {
      clusterMode: "shared_project" as const,
      serviceName: "deployguard-app",
      launchType: "fargate" as const,
      capacityProviders: ["FARGATE"],
    },
    ingress: {
      enabled: true,
      protocol: "HTTP" as const,
      containerPort: 3000,
      targetGroupPort: 3000,
      healthCheckPath: "/api/health",
      healthCheckProtocol: "HTTP" as const,
    },
    database: {
      mode: "none" as const,
      engine: null,
      tierRevision: null,
      persistence: false,
      externalTlsRequired: null,
    },
    storage: {
      efsRequired: false,
      accessPointRequired: false,
      encrypted: true,
      backupRequired: false,
    },
    discovery: { cloudMapRequired: false, namespace: null },
    observability: {
      cloudWatchLogs: true,
      cloudWatchMetrics: true,
      prometheus: false,
    },
    iamPolicyRevision: "v1",
    tags: { managedBy: "DeployGuard" },
  };
  const releaseSpec = {
    source: {
      repositoryFullName: "example/web-app",
      branch: "main",
      commitSha: "b".repeat(40),
      appRoot: ".",
    },
    build: {
      dockerStrategy: "generated" as const,
      dockerTemplate: "node-server-v1",
      buildCommand: "npm run build",
      outputDirectory: null,
      buildArgumentNames: [],
    },
    runtime: {
      imageUri: null,
      imageDigest: null,
      command: "npm start",
      containerPort: 3000,
      cpu: 256,
      memory: 512,
      plainVariableNames: ["NODE_ENV"],
      secretReferenceNames: ["DATABASE_URL", "JWT_SECRET"],
      serviceBindingRevisions: [],
    },
    health: {
      path: "/api/health",
      expectedPort: 3000,
      gracePeriodSeconds: 60,
    },
  };
  const terraformOutputs = {
    ecs_cluster_arn: clusterArn,
    ecs_service_arn: serviceArn,
    ecs_service_name: "deployguard-app",
    ecs_task_definition_arn: taskDefinitionArn,
    ecs_container_name: "app",
    ecs_log_group_name: "/deployguard/project/app",
  };
  return {
    infrastructure: {
      id: infrastructureManifestId,
      schemaVersion: 1,
      projectId,
      environmentName: "production",
      revision: "4",
      parentManifestId: null,
      createdByIntentId: null,
      createdByUserId: null,
      origin: "planner",
      status: "applied",
      specHash: canonicalSha256(desiredSpec),
      terraformTemplateVersion: "v1",
      stateBackend: "s3",
      stateKey: `projects/${projectId}/terraform.tfstate`,
      desiredSpec,
      changeSet: {
        fromManifestId: null,
        changedPaths: ["network"],
        categories: ["network"],
        destructivePaths: [],
        requiresApproval: true,
        reasonCodes: ["INITIAL_INFRASTRUCTURE"],
      },
      requiresTerraform: true,
      terraformOutputs,
      terraformOutputsHash: canonicalSha256(terraformOutputs),
    },
    release: {
      id: releaseManifestId,
      schemaVersion: 1,
      projectId,
      environmentName: "production",
      revision: "8",
      parentManifestId: null,
      previousStableManifestId: null,
      infrastructureManifestId,
      createdByIntentId: null,
      pipelineRunId: null,
      deploymentContractId: null,
      configurationSnapshotId,
      origin: "planner",
      status: "built",
      specHash: canonicalSha256(releaseSpec),
      repositoryFullName: releaseSpec.source.repositoryFullName,
      branch: releaseSpec.source.branch,
      commitSha: releaseSpec.source.commitSha,
      appRoot: releaseSpec.source.appRoot,
      deploymentContractHash: "a".repeat(64),
      configurationFingerprint: "a".repeat(64),
      buildFingerprint: "a".repeat(64),
      runtimeFingerprint: "a".repeat(64),
      releaseSpec,
      imageUri:
        "123456789012.dkr.ecr.us-east-1.amazonaws.com/deployguard-app:build-8",
      imageDigest,
      taskDefinitionInputHash: null,
      taskDefinitionArn: null,
    },
  };
}

const revision = {
  projectId,
  environmentName: "production",
  releaseManifestId,
  releaseRevision: "8",
  infrastructureManifestId,
  infrastructureRevision: "4",
};
const mutation = {
  idempotencyKey: mutationKey,
  registerTaskDefinitionOperationId:
    "55555555-5555-4555-8555-555555555555",
  updateServiceOperationId: "66666666-6666-4666-8666-666666666666",
};

assertV1EcsReleaseMutationIdentity(revision, mutation, 5_000);
const plan = buildV1EcsReleaseMutationPlan(revision, pair());
assert.equal(
  plan.registerTaskDefinition.immutableImage,
  `123456789012.dkr.ecr.us-east-1.amazonaws.com/deployguard-app@${imageDigest}`,
);
assert.equal(plan.updateService.clusterArn, clusterArn);
assert.equal(plan.updateService.serviceArn, serviceArn);
assert.equal(plan.registerTaskDefinition.sourceTaskDefinitionArn, taskDefinitionArn);
const releaseOwnedRuntime = pair();
for (const key of ["ecs_service_arn", "ecs_service_name", "ecs_task_definition_arn", "ecs_container_name"]) {
  delete releaseOwnedRuntime.infrastructure.terraformOutputs[key];
}
releaseOwnedRuntime.infrastructure.terraformOutputsHash = canonicalSha256(
  releaseOwnedRuntime.infrastructure.terraformOutputs,
);
releaseOwnedRuntime.stableRuntime = {
  serviceArn,
  taskDefinitionArn,
  serviceName: "deployguard-app",
  containerName: "app",
};
const releaseOwnedRuntimePlan = buildV1EcsReleaseMutationPlan(revision, releaseOwnedRuntime);
assert.equal(releaseOwnedRuntimePlan.updateService.serviceArn, serviceArn);
assert.equal(releaseOwnedRuntimePlan.registerTaskDefinition.sourceTaskDefinitionArn, taskDefinitionArn);
const conflictingRuntime = pair();
conflictingRuntime.stableRuntime = {
  serviceArn: serviceArn.replace("deployguard-app", "different-service"),
  taskDefinitionArn,
  serviceName: "deployguard-app",
  containerName: "app",
};
assert.throws(
  () => buildV1EcsReleaseMutationPlan(revision, conflictingRuntime),
  /ECS_RELEASE_INFRASTRUCTURE_IDENTITY_INVALID/,
);
assert.deepEqual(
  plan.registerTaskDefinition.environmentReferences,
  [
    {
      name: "NODE_ENV",
      source: "configuration_snapshot",
      configurationSnapshotId,
    },
    {
      name: "DATABASE_URL",
      source: "secret_reference",
      configurationSnapshotId,
    },
    {
      name: "JWT_SECRET",
      source: "secret_reference",
      configurationSnapshotId,
    },
  ],
);
assert.equal(
  JSON.stringify(plan.registerTaskDefinition).includes("secret-value"),
  false,
);
assert.deepEqual(plan.registerTaskDefinition.evidenceTags, {
  projectId,
  environmentName: "production",
  releaseManifestId,
  releaseRevision: "8",
  infrastructureManifestId,
  infrastructureRevision: "4",
  taskDefinitionInputHash: plan.taskDefinitionInputHash,
  imageDigest,
});
assert.notEqual(
  deriveV1EcsReleaseEffectIdempotencyKey(
    mutationKey,
    "register_task_definition",
  ),
  deriveV1EcsReleaseEffectIdempotencyKey(mutationKey, "update_service"),
);

assert.throws(
  () => buildV1EcsReleaseMutationPlan(revision, {
    ...pair(),
    infrastructure: { ...pair().infrastructure, status: "failed" } as any,
  }),
  /ECS_RELEASE_INFRASTRUCTURE_NOT_APPLIED/,
);
assert.throws(
  () => buildV1EcsReleaseMutationPlan(revision, {
    ...pair(),
    release: { ...pair().release, imageDigest: null },
  }),
  /ECS_RELEASE_IMAGE_DIGEST_REQUIRED/,
);
assert.throws(
  () => buildV1EcsReleaseMutationPlan({
    ...revision,
    releaseRevision: "9",
  }, pair()),
  /ECS_RELEASE_CONTRACT_INVALID/,
);
const portMismatch = pair();
portMismatch.release.releaseSpec.runtime.containerPort = 8080;
portMismatch.release.specHash = canonicalSha256(portMismatch.release.releaseSpec);
assert.throws(
  () => buildV1EcsReleaseMutationPlan(revision, portMismatch),
  /ECS_RELEASE_INFRASTRUCTURE_IDENTITY_INVALID/,
);

const adapterSource = readFileSync(
  "src/orchestration-contracts/worker-runtime/inactive-v1-ecs-release-mutation.adapter.ts",
  "utf8",
);
const storeSource = readFileSync(
  "src/orchestration-contracts/worker-runtime/inactive-v1-ecs-release-manifest.store.ts",
  "utf8",
);
const moduleSource = readFileSync(
  "src/orchestration-contracts/orchestration-contracts.module.ts",
  "utf8",
);
assert.doesNotMatch(
  adapterSource,
  /@aws-sdk|Terraform|terraform|createCluster|createService|createLoadBalancer|createVpc|promot|stable|completed/,
);
assert.doesNotMatch(
  adapterSource,
  /OnModuleInit|OnApplicationBootstrap|@Controller|new Worker/,
);
assert.doesNotMatch(
  moduleSource,
  /InactiveV1EcsReleaseMutationAdapter/,
);
assert.match(storeSource, /releaseManifestId/);
assert.match(storeSource, /infrastructureManifestId/);
assert.match(storeSource, /task_definition_input_hash IS NULL/);
assert.doesNotMatch(storeSource, /deployment_intents[\s\S]*SET status/);

console.log("Inactive v1 ECS release mutation contract verification passed");
