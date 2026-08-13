import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { canonicalSha256 } from "../src/orchestration-contracts/contracts/canonical-json";
import {
  prepareInactiveV1EcsReleaseReconciliationAdapter,
} from "../src/orchestration-contracts/worker-runtime/inactive-v1-ecs-release-reconciliation.adapter";
import {
  V1EcsReleaseFixtureReadOnlyClient,
  V1EcsServiceUpdateReadEvidence,
  V1EcsTaskDefinitionReadEvidence,
} from "../src/orchestration-contracts/worker-runtime/inactive-v1-ecs-release-reconciliation.types";
import {
  buildV1EcsReleaseMutationPlan,
} from "../src/orchestration-contracts/worker-runtime/inactive-v1-ecs-release-mutation.pure";
import {
  V1EcsReleaseManifestPair,
} from "../src/orchestration-contracts/worker-runtime/inactive-v1-ecs-release-mutation.types";
import {
  v1HandlerSideEffectRequestFingerprint,
} from "../src/orchestration-contracts/worker-runtime/v1-handler-side-effect.pure";
import {
  V1HandlerSideEffectSnapshot,
} from "../src/orchestration-contracts/worker-runtime/v1-handler-side-effect.types";

const projectId = "11111111-1111-4111-8111-111111111111";
const infrastructureManifestId = "22222222-2222-4222-8222-222222222222";
const releaseManifestId = "33333333-3333-4333-8333-333333333333";
const configurationSnapshotId = "44444444-4444-4444-8444-444444444444";
const imageDigest = `sha256:${"e".repeat(64)}`;
const immutableImage =
  `123456789012.dkr.ecr.us-east-1.amazonaws.com/deployguard-app@${imageDigest}`;
const clusterArn =
  "arn:aws:ecs:us-east-1:123456789012:cluster/deployguard-project";
const serviceArn =
  "arn:aws:ecs:us-east-1:123456789012:service/deployguard-project/deployguard-app";
const sourceTaskDefinitionArn =
  "arn:aws:ecs:us-east-1:123456789012:task-definition/deployguard-app:7";
const releaseTaskDefinitionArn =
  "arn:aws:ecs:us-east-1:123456789012:task-definition/deployguard-app:8";

const revision = {
  projectId,
  environmentName: "production",
  releaseManifestId,
  releaseRevision: "8",
  infrastructureManifestId,
  infrastructureRevision: "4",
};

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
      secretReferenceNames: ["DATABASE_URL"],
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
    ecs_task_definition_arn: sourceTaskDefinitionArn,
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

type FixtureState = {
  tasks: unknown[];
  services: unknown[];
  throwRead: boolean;
  loseTrustOnRead: boolean;
};

function client(
  state: FixtureState,
  onLoseTrust: () => void = () => undefined,
): V1EcsReleaseFixtureReadOnlyClient {
  return {
    policy:
      "deployguard.ecs-release-reconciliation/fixture-read-only-v1",
    async findTaskDefinitionEvidence() {
      if (state.loseTrustOnRead) onLoseTrust();
      if (state.throwRead) throw new Error("raw credential-like SDK error");
      return state.tasks as V1EcsTaskDefinitionReadEvidence[];
    },
    async findServiceUpdateEvidence() {
      if (state.loseTrustOnRead) onLoseTrust();
      if (state.throwRead) throw new Error("raw credential-like SDK error");
      return state.services as V1EcsServiceUpdateReadEvidence[];
    },
  };
}

function taskEvidence(taskDefinitionInputHash: string):
V1EcsTaskDefinitionReadEvidence {
  return {
    taskDefinitionArn: releaseTaskDefinitionArn,
    family: "deployguard-app",
    containerName: "app",
    projectId,
    environmentName: "production",
    releaseManifestId,
    releaseRevision: "8",
    infrastructureManifestId,
    infrastructureRevision: "4",
    taskDefinitionInputHash,
    immutableImage,
    imageDigest,
    status: "ACTIVE",
  };
}

function serviceEvidence(
  serviceUpdateInputHash: string,
  taskDefinitionInputHash: string,
):
V1EcsServiceUpdateReadEvidence {
  return {
    clusterArn,
    serviceArn,
    family: "deployguard-app",
    containerName: "app",
    projectId,
    environmentName: "production",
    releaseManifestId,
    releaseRevision: "8",
    infrastructureManifestId,
    infrastructureRevision: "4",
    taskDefinitionInputHash,
    serviceUpdateInputHash,
    taskDefinitionArn: releaseTaskDefinitionArn,
    taskDefinitionStatus: "ACTIVE",
    imageDigest,
    serviceStatus: "ACTIVE",
    rolloutState: "COMPLETED",
  };
}

function context(
  effectType: string,
  inputFingerprint: string,
  trusted: () => boolean,
) {
  const now = new Date();
  const sideEffect: V1HandlerSideEffectSnapshot = {
    id: randomUUID(),
    intentId: randomUUID(),
    projectId,
    environmentName: "production",
    operationId: randomUUID(),
    effectType,
    idempotencyKey: canonicalSha256({ effectType }),
    requestFingerprint: "",
    leaseId: randomUUID(),
    workerId: "session7.2-fixture-worker",
    fencingToken: "3",
    status: "uncertain",
    safeResultCode: null,
    resultFingerprint: null,
    externalReferenceHash: null,
    failureCode: "ECS_RESULT_UNCERTAIN",
    reconciliationRequired: true,
    attemptStartedAt: now,
    deadlineAt: new Date(now.getTime() + 5_000),
    completedAt: now,
    createdAt: now,
    updatedAt: now,
  };
  sideEffect.requestFingerprint = v1HandlerSideEffectRequestFingerprint({
    intentId: sideEffect.intentId,
    projectId: sideEffect.projectId,
    environmentName: sideEffect.environmentName,
    operationId: sideEffect.operationId,
    idempotencyKey: sideEffect.idempotencyKey,
    effectType: sideEffect.effectType,
    inputFingerprint,
    leaseId: sideEffect.leaseId,
    workerId: sideEffect.workerId,
    fencingToken: sideEffect.fencingToken,
  });
  return {
    readOnly: true as const,
    sideEffect,
    signal: new AbortController().signal,
    deadlineAt: new Date(Date.now() + 5_000),
    intentId: sideEffect.intentId,
    projectId,
    environmentName: "production",
    leaseId: randomUUID(),
    workerId: "session7.2-reconciliation-worker",
    fencingToken: "9",
    isLeaseTrusted: trusted,
  };
}

async function run() {
  const base = pair();
  const plan = buildV1EcsReleaseMutationPlan(revision, base);
  const state: FixtureState = {
    tasks: [taskEvidence(plan.taskDefinitionInputHash)],
    services: [],
    throwRead: false,
    loseTrustOnRead: false,
  };
  let trusted = true;
  const taskPrepared =
    await prepareInactiveV1EcsReleaseReconciliationAdapter({
      effect: "register_task_definition",
      revision,
      manifests: {
        async loadExact() { return base; },
        async recordTaskDefinitionReference() {
          throw new Error("reconciliation must never mutate manifests");
        },
      },
      client: client(state, () => { trusted = false; }),
    });
  assert.match(taskPrepared.inspectionFingerprint, /^[0-9a-f]{64}$/);
  const taskContext = context(
    "ecs.register_task_definition_revision",
    plan.taskDefinitionInputHash,
    () => trusted,
  );
  assert.equal(
    (await taskPrepared.adapter.inspect(taskContext)).classification,
    "succeeded",
  );

  state.tasks = [];
  assert.equal(
    (await taskPrepared.adapter.inspect(taskContext)).classification,
    "pending",
  );
  state.tasks = [{
    ...taskEvidence(plan.taskDefinitionInputHash),
    status: "INACTIVE",
  }];
  assert.equal(
    (await taskPrepared.adapter.inspect(taskContext)).classification,
    "failed",
  );
  state.tasks = [
    taskEvidence(plan.taskDefinitionInputHash),
    taskEvidence(plan.taskDefinitionInputHash),
  ];
  assert.equal(
    (await taskPrepared.adapter.inspect(taskContext)).classification,
    "manual_review",
  );
  state.tasks = [{
    ...taskEvidence(plan.taskDefinitionInputHash),
    projectId: randomUUID(),
  }];
  assert.equal(
    (await taskPrepared.adapter.inspect(taskContext)).classification,
    "manual_review",
  );
  state.tasks = [{
    ...taskEvidence(plan.taskDefinitionInputHash),
    rawSdkResponse: "must-not-be-accepted",
  }];
  assert.equal(
    (await taskPrepared.adapter.inspect(taskContext)).classification,
    "manual_review",
  );
  state.throwRead = true;
  const readFailure = await taskPrepared.adapter.inspect(taskContext);
  assert.equal(readFailure.classification, "manual_review");
  assert.doesNotMatch(
    JSON.stringify(readFailure),
    /credential|SDK|raw/i,
  );
  state.throwRead = false;

  const mismatchContext = context(
    "ecs.register_task_definition_revision",
    "f".repeat(64),
    () => true,
  );
  let reads = 0;
  const noReadPrepared =
    await prepareInactiveV1EcsReleaseReconciliationAdapter({
      effect: "register_task_definition",
      revision,
      manifests: {
        async loadExact() { return base; },
        async recordTaskDefinitionReference() {
          throw new Error("unreachable");
        },
      },
      client: {
        policy:
          "deployguard.ecs-release-reconciliation/fixture-read-only-v1",
        async findTaskDefinitionEvidence() {
          reads += 1;
          return [];
        },
        async findServiceUpdateEvidence() {
          reads += 1;
          return [];
        },
      },
    });
  assert.equal(
    (await noReadPrepared.adapter.inspect(mismatchContext)).classification,
    "manual_review",
  );
  assert.equal(reads, 0);

  const servicePair = pair();
  const servicePlan = buildV1EcsReleaseMutationPlan(revision, servicePair);
  servicePair.release.taskDefinitionInputHash =
    servicePlan.taskDefinitionInputHash;
  servicePair.release.taskDefinitionArn = releaseTaskDefinitionArn;
  const serviceInputFingerprint = canonicalSha256({
    schemaVersion: 1,
    serviceUpdateInputHash: servicePlan.serviceUpdateInputHash,
    taskDefinitionArn: releaseTaskDefinitionArn,
  });
  state.services = [
    serviceEvidence(
      servicePlan.serviceUpdateInputHash,
      servicePlan.taskDefinitionInputHash,
    ),
  ];
  const servicePrepared =
    await prepareInactiveV1EcsReleaseReconciliationAdapter({
      effect: "update_service",
      revision,
      manifests: {
        async loadExact() { return servicePair; },
        async recordTaskDefinitionReference() {
          throw new Error("reconciliation must never mutate manifests");
        },
      },
      client: client(state),
    });
  const serviceContext = context(
    "ecs.update_existing_service",
    serviceInputFingerprint,
    () => true,
  );
  assert.equal(
    (await servicePrepared.adapter.inspect(serviceContext)).classification,
    "succeeded",
  );
  state.services = [{
    ...serviceEvidence(
      servicePlan.serviceUpdateInputHash,
      servicePlan.taskDefinitionInputHash,
    ),
    rolloutState: "IN_PROGRESS",
  }];
  assert.equal(
    (await servicePrepared.adapter.inspect(serviceContext)).classification,
    "pending",
  );
  state.services = [{
    ...serviceEvidence(
      servicePlan.serviceUpdateInputHash,
      servicePlan.taskDefinitionInputHash,
    ),
    rolloutState: "FAILED",
  }];
  assert.equal(
    (await servicePrepared.adapter.inspect(serviceContext)).classification,
    "failed",
  );
  state.services = [{
    ...serviceEvidence(
      servicePlan.serviceUpdateInputHash,
      servicePlan.taskDefinitionInputHash,
    ),
    serviceArn:
      "arn:aws:ecs:us-east-1:123456789012:service/other/other",
  }];
  assert.equal(
    (await servicePrepared.adapter.inspect(serviceContext)).classification,
    "manual_review",
  );

  state.tasks = [taskEvidence(plan.taskDefinitionInputHash)];
  state.loseTrustOnRead = true;
  trusted = true;
  await assert.rejects(
    () => Promise.resolve(taskPrepared.adapter.inspect(taskContext)),
    /ECS_RELEASE_RECONCILIATION_OWNERSHIP_LOST/,
  );

  const missingReference = pair();
  await assert.rejects(
    () => prepareInactiveV1EcsReleaseReconciliationAdapter({
      effect: "update_service",
      revision,
      manifests: {
        async loadExact() { return missingReference; },
        async recordTaskDefinitionReference() {
          throw new Error("unreachable");
        },
      },
      client: client(state),
    }),
    /ECS_RELEASE_RECONCILIATION_CONTRACT_INVALID/,
  );

  const adapterSource = readFileSync(
    "src/orchestration-contracts/worker-runtime/"
      + "inactive-v1-ecs-release-reconciliation.adapter.ts",
    "utf8",
  );
  const typesSource = readFileSync(
    "src/orchestration-contracts/worker-runtime/"
      + "inactive-v1-ecs-release-reconciliation.types.ts",
    "utf8",
  );
  const moduleSource = readFileSync(
    "src/orchestration-contracts/orchestration-contracts.module.ts",
    "utf8",
  );
  assert.doesNotMatch(
    `${adapterSource}\n${typesSource}`,
    /@aws-sdk|registerTaskDefinitionRevision|updateExistingService|Terraform|promot|rollback/i,
  );
  assert.doesNotMatch(
    adapterSource,
    /OnModuleInit|OnApplicationBootstrap|@Controller|new Worker/,
  );
  assert.doesNotMatch(
    moduleSource,
    /InactiveV1EcsReleaseReconciliation/,
  );
  assert.match(typesSource, /fixture-read-only-v1/);

  console.log(
    "Inactive v1 ECS release reconciliation fixture verification passed",
  );
}

void run();
