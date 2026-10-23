import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { canonicalSha256 } from "../src/orchestration-contracts/contracts/canonical-json";
import { InactiveV1EcsReleaseHandler } from
  "../src/orchestration-contracts/worker-runtime/inactive-v1-ecs-release-handler";
import { InactiveV1EcsReleaseManifestStore } from
  "../src/orchestration-contracts/worker-runtime/inactive-v1-ecs-release-manifest.store";
import { InactiveV1EcsReleaseMutationAdapter } from
  "../src/orchestration-contracts/worker-runtime/inactive-v1-ecs-release-mutation.adapter";
import {
  V1EcsReleaseManifestPair,
  V1EcsReleaseManifestStore,
  V1EcsReleaseMutationClient,
} from "../src/orchestration-contracts/worker-runtime/inactive-v1-ecs-release-mutation.types";
import { InactiveV1EcsReleaseOutcomeCoordinator } from
  "../src/orchestration-contracts/worker-runtime/inactive-v1-ecs-release-outcome.coordinator";
import {
  V1EcsReleaseOutcomeStore,
} from "../src/orchestration-contracts/worker-runtime/inactive-v1-ecs-release-outcome.types";
import {
  V1EcsRolloutHealthVerificationResult,
  V1EcsRolloutHealthVerifier,
} from "../src/orchestration-contracts/worker-runtime/inactive-v1-ecs-rollout-health.types";
import {
  V1FencedPlaceholderHandlerContext,
} from "../src/orchestration-contracts/worker-runtime/v1-fenced-invocation.types";
import {
  V1HandlerSideEffectBoundary,
  V1HandlerSideEffectResult,
  V1HandlerSideEffectSnapshot,
} from "../src/orchestration-contracts/worker-runtime/v1-handler-side-effect.types";
import {
  buildV1InactiveReleaseHandlerRegistry,
} from "../src/orchestration-contracts/worker-runtime/v1-placeholder-handlers";

const projectId = "11111111-1111-4111-8111-111111111111";
const infrastructureManifestId =
  "22222222-2222-4222-8222-222222222222";
const releaseManifestId = "33333333-3333-4333-8333-333333333333";
const previousStableId = "44444444-4444-4444-8444-444444444444";
const intentId = "55555555-5555-4555-8555-555555555555";
const leaseId = "66666666-6666-4666-8666-666666666666";
const configurationSnapshotId =
  "77777777-7777-4777-8777-777777777777";
const clusterArn =
  "arn:aws:ecs:us-east-1:123456789012:cluster/deployguard";
const serviceArn =
  "arn:aws:ecs:us-east-1:123456789012:service/deployguard/app";
const sourceTaskDefinitionArn =
  "arn:aws:ecs:us-east-1:123456789012:task-definition/app:7";
const candidateTaskDefinitionArn =
  "arn:aws:ecs:us-east-1:123456789012:task-definition/app:8";

function manifestPair(): V1EcsReleaseManifestPair {
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
      serviceName: "app",
      launchType: "fargate" as const,
      capacityProviders: ["FARGATE"],
    },
    ingress: {
      enabled: true,
      protocol: "HTTP" as const,
      containerPort: 3000,
      targetGroupPort: 3000,
      healthCheckPath: "/health",
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
      repositoryFullName: "example/app",
      branch: "main",
      commitSha: "a".repeat(40),
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
      path: "/health",
      expectedPort: 3000,
      gracePeriodSeconds: 60,
    },
  };
  const outputs = {
    ecs_cluster_arn: clusterArn,
    ecs_service_arn: serviceArn,
    ecs_service_name: "app",
    ecs_task_definition_arn: sourceTaskDefinitionArn,
    ecs_container_name: "app",
    ecs_log_group_name: "/deployguard/app",
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
        changedPaths: [],
        categories: [],
        destructivePaths: [],
        requiresApproval: false,
        reasonCodes: [],
      },
      requiresTerraform: false,
      terraformOutputs: outputs,
      terraformOutputsHash: canonicalSha256(outputs),
    },
    release: {
      id: releaseManifestId,
      schemaVersion: 1,
      projectId,
      environmentName: "production",
      revision: "9",
      parentManifestId: null,
      previousStableManifestId: previousStableId,
      infrastructureManifestId,
      createdByIntentId: intentId,
      pipelineRunId: null,
      deploymentContractId: null,
      configurationSnapshotId,
      origin: "planner",
      status: "built",
      specHash: canonicalSha256(releaseSpec),
      repositoryFullName: "example/app",
      branch: "main",
      commitSha: "a".repeat(40),
      appRoot: ".",
      deploymentContractHash: "b".repeat(64),
      configurationFingerprint: "c".repeat(64),
      buildFingerprint: "d".repeat(64),
      runtimeFingerprint: "e".repeat(64),
      releaseSpec,
      imageUri:
        "123456789012.dkr.ecr.us-east-1.amazonaws.com/app:build-9",
      imageDigest: `sha256:${"f".repeat(64)}`,
      taskDefinitionInputHash: null,
      taskDefinitionArn: null,
    },
  };
}

class FixtureManifestStore implements V1EcsReleaseManifestStore {
  pair = manifestPair();
  async loadExact() {
    return this.pair;
  }
  async recordTaskDefinitionReference(input: any) {
    this.pair.release.taskDefinitionInputHash =
      input.taskDefinitionInputHash;
    this.pair.release.taskDefinitionArn = input.taskDefinitionArn;
    return {
      taskDefinitionInputHash: input.taskDefinitionInputHash,
      taskDefinitionArn: input.taskDefinitionArn,
    };
  }
}

class FixtureMutationClient implements V1EcsReleaseMutationClient {
  readonly policy = "deployguard.ecs-release-mutation/client-v1" as const;
  registerCalls = 0;
  updateCalls = 0;
  async registerTaskDefinitionRevision() {
    this.registerCalls += 1;
    return { taskDefinitionArn: candidateTaskDefinitionArn };
  }
  async updateExistingService(request: any) {
    this.updateCalls += 1;
    assert.equal(request.clusterArn, clusterArn);
    assert.equal(request.serviceArn, serviceArn);
    return { serviceArn };
  }
}

class FixtureVerifier implements V1EcsRolloutHealthVerifier {
  readonly policy =
    "deployguard.ecs-rollout-health/disabled-read-only-v1" as const;
  calls = 0;
  constructor(
    private readonly results: V1EcsRolloutHealthVerificationResult[],
  ) {}
  async verify() {
    const result = this.results[this.calls++];
    assert.ok(result, "unexpected rollout verification");
    return result;
  }
}

class FixtureOutcomeStore implements V1EcsReleaseOutcomeStore {
  promotions = 0;
  rollbacks = 0;
  missing = false;
  private promoted = false;
  async promoteCandidate() {
    if (this.promoted) return { disposition: "replayed" as const };
    this.promoted = true;
    this.promotions += 1;
    return { disposition: "promoted" as const };
  }
  async prepareRollback(input: any) {
    if (this.missing) {
      return {
        disposition: "rollback_target_missing",
        safeCode: "ECS_PREVIOUS_STABLE_RELEASE_MISSING",
      } as const;
    }
    return {
      disposition: "rollback_prepared",
      target: {
        rollbackManifestId:
          "88888888-8888-4888-8888-888888888888",
        rollbackRevision: "10",
        previousStable: {
          ...input.revision,
          releaseManifestId: previousStableId,
          releaseRevision: "8",
          taskDefinitionArn: sourceTaskDefinitionArn,
        },
        clusterArn,
        serviceArn,
        inputFingerprint: input.inputFingerprint,
      },
    } as const;
  }
  async finalizeRollback() {
    this.rollbacks += 1;
    return { disposition: "rolled_back" as const };
  }
}

function health(
  status: V1EcsRolloutHealthVerificationResult["status"],
): V1EcsRolloutHealthVerificationResult {
  const codes = {
    healthy: "ECS_ROLLOUT_AND_TARGETS_HEALTHY",
    progressing: "ECS_ROLLOUT_PROGRESSING",
    failed: "ECS_ROLLOUT_FAILED",
    timed_out: "ECS_ROLLOUT_HEALTH_TIMEOUT",
    ambiguous: "ECS_ROLLOUT_EVIDENCE_AMBIGUOUS",
  } as const;
  return {
    status,
    safeCode: codes[status],
    evidenceHash: canonicalSha256({ status }),
  };
}

class MemorySideEffects implements V1HandlerSideEffectBoundary {
  private readonly effects = new Map<string, V1HandlerSideEffectSnapshot>();
  private readonly inflight =
    new Map<string, Promise<V1HandlerSideEffectResult>>();
  reconciliation = false;
  uncertainEffectType: string | null = null;
  calls = 0;
  async execute(request: any): Promise<V1HandlerSideEffectResult> {
    const existing = this.effects.get(request.idempotencyKey);
    if (existing) {
      if (existing.requestFingerprint !== request.inputFingerprint) {
        throw new Error("SIDE_EFFECT_IDEMPOTENCY_CONFLICT");
      }
      return existing.status === "succeeded"
        ? { disposition: "replayed", effect: existing }
        : {
            disposition: "reconciliation_required",
            reason: "effect_outcome_uncertain",
            effect: existing,
          };
    }
    const inflight = this.inflight.get(request.idempotencyKey);
    if (inflight) return inflight;
    const execution = this.executeNew(request);
    this.inflight.set(request.idempotencyKey, execution);
    try {
      return await execution;
    } finally {
      this.inflight.delete(request.idempotencyKey);
    }
  }

  private async executeNew(
    request: any,
  ): Promise<V1HandlerSideEffectResult> {
    this.calls += 1;
    const ownership = {
      intentId,
      projectId,
      environmentName: "production",
      operationId: request.operationId,
      idempotencyKey: request.idempotencyKey,
      effectType: request.effectType,
      inputFingerprint: request.inputFingerprint,
      leaseId,
      workerId: "release-worker",
      fencingToken: "3",
      signal: new AbortController().signal,
      deadlineAt: new Date(Date.now() + 5_000),
      isLeaseTrusted: () => true,
    };
    const result = this.uncertainEffectType === request.effectType
      ? {
          outcome: "uncertain",
          safeFailureCode: "FIXTURE_EFFECT_UNCERTAIN",
        }
      : await request.perform(ownership);
    const succeeded = result.outcome === "succeeded";
    const snapshot: V1HandlerSideEffectSnapshot = {
      id: canonicalUuid(request.idempotencyKey),
      ...ownership,
      requestFingerprint: request.inputFingerprint,
      status: succeeded ? "succeeded" : "uncertain",
      safeResultCode: succeeded ? result.safeResultCode : null,
      resultFingerprint: succeeded ? result.resultFingerprint : null,
      externalReferenceHash: succeeded
        ? result.externalReferenceHash ?? null
        : null,
      failureCode: succeeded ? null : result.safeFailureCode,
      reconciliationRequired: !succeeded,
      attemptStartedAt: new Date(),
      deadlineAt: ownership.deadlineAt,
      completedAt: succeeded ? new Date() : null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.effects.set(request.idempotencyKey, snapshot);
    if (!succeeded) {
      this.reconciliation = true;
      return {
        disposition: "reconciliation_required",
        reason: "effect_outcome_uncertain",
        effect: snapshot,
      };
    }
    return { disposition: "executed", effect: snapshot };
  }
  finalizationStatus() {
    return this.reconciliation
      ? {
          allowed: false as const,
          safeFailureCode: "SIDE_EFFECT_RECONCILIATION_REQUIRED",
        }
      : { allowed: true as const, safeFailureCode: null };
  }
}

function canonicalUuid(value: string) {
  const hash = canonicalSha256(value);
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}`
    + `-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

function context(
  store: FixtureManifestStore,
  sideEffects: V1HandlerSideEffectBoundary,
  trusted = () => true,
  signal = new AbortController().signal,
): V1FencedPlaceholderHandlerContext<"intent.release.execute"> {
  const now = new Date();
  return {
    leaseId,
    workerId: "release-worker",
    fencingToken: "3",
    logicalJobId: "dg1:release:fixture",
    lease: {
      leaseId,
      intentId,
      projectId,
      environmentName: "production",
      lane: "release",
      scope: "execute",
      ownerWorkerId: "release-worker",
      fencingToken: "3",
      status: "heartbeat_active",
      acquiredAt: now,
      heartbeatAt: now,
      expiresAt: new Date(now.getTime() + 60_000),
    },
    intent: {
      id: intentId,
      projectId,
      environmentName: "production",
      classification: "release_only",
      status: "running",
      canonicalIdempotencyKey: "a".repeat(64),
      infrastructureManifestId,
      releaseManifestId,
      pipelineRunId: null,
      destroyOperationId: null,
    },
    infrastructureManifest: store.pair.infrastructure,
    releaseManifest: store.pair.release,
    route: {
      messageType: "intent.release.execute",
      queueName: "deployguard-release-v1",
      lane: "release",
      operation: "execute",
    },
    execution: {
      signal,
      isLeaseTrusted: trusted,
    },
    sideEffects,
    envelope: {} as any,
  };
}

function fixture(
  statuses: V1EcsRolloutHealthVerificationResult[],
) {
  const manifests = new FixtureManifestStore();
  const client = new FixtureMutationClient();
  const verifier = new FixtureVerifier(statuses);
  const outcomes = new FixtureOutcomeStore();
  const mutation = new InactiveV1EcsReleaseMutationAdapter(
    manifests,
    client,
  );
  const coordinator = new InactiveV1EcsReleaseOutcomeCoordinator({
    manifests,
    outcomes,
    mutationClient: client,
    verifier,
  });
  const handler = new InactiveV1EcsReleaseHandler(
    mutation,
    coordinator,
    {
      sideEffectTimeoutMs: 5_000,
      rolloutTimeoutMs: 5_000,
      rollbackTimeoutMs: 5_000,
      now: () => new Date("2026-07-24T12:00:00.000Z"),
    },
  );
  return { manifests, client, verifier, outcomes, handler };
}

void (async () => {
  const healthy = fixture([health("healthy")]);
  const healthyEffects = new MemorySideEffects();
  assert.deepEqual(
    await healthy.handler.invoke(
      context(healthy.manifests, healthyEffects),
    ),
    { outcome: "success" },
  );
  assert.equal(healthy.client.registerCalls, 1);
  assert.equal(healthy.client.updateCalls, 1);
  assert.equal(healthy.outcomes.promotions, 1);

  const retry = fixture([health("progressing"), health("healthy")]);
  const retryEffects = new MemorySideEffects();
  assert.deepEqual(
    await retry.handler.invoke(context(retry.manifests, retryEffects)),
    { outcome: "retryable" },
  );
  assert.deepEqual(
    await retry.handler.invoke(context(retry.manifests, retryEffects)),
    { outcome: "success" },
  );
  assert.equal(retry.client.registerCalls, 1);
  assert.equal(retry.client.updateCalls, 1);

  const concurrent = fixture([health("healthy"), health("healthy")]);
  const concurrentEffects = new MemorySideEffects();
  assert.deepEqual(
    await Promise.all([
      concurrent.handler.invoke(
        context(concurrent.manifests, concurrentEffects),
      ),
      concurrent.handler.invoke(
        context(concurrent.manifests, concurrentEffects),
      ),
    ]),
    [{ outcome: "success" }, { outcome: "success" }],
  );
  assert.equal(concurrent.client.registerCalls, 1);
  assert.equal(concurrent.client.updateCalls, 1);
  assert.equal(concurrent.outcomes.promotions, 1);

  for (const failedStatus of ["failed", "timed_out"] as const) {
    const rollback = fixture([
      health(failedStatus),
      health("healthy"),
    ]);
    const rollbackEffects = new MemorySideEffects();
    assert.deepEqual(
      await rollback.handler.invoke(
        context(rollback.manifests, rollbackEffects),
      ),
      { outcome: "success" },
    );
    assert.equal(rollback.client.updateCalls, 2);
    assert.equal(rollback.outcomes.rollbacks, 1);
  }

  const missing = fixture([health("failed")]);
  missing.outcomes.missing = true;
  assert.deepEqual(
    await missing.handler.invoke(
      context(missing.manifests, new MemorySideEffects()),
    ),
    {
      outcome: "terminal_failure",
      safeFailureCode: "RELEASE_ROLLBACK_TARGET_MISSING",
    },
  );

  const uncertain = fixture([health("healthy")]);
  const uncertainEffects = new MemorySideEffects();
  uncertainEffects.uncertainEffectType = "ecs.update_existing_service";
  assert.deepEqual(
    await uncertain.handler.invoke(
      context(uncertain.manifests, uncertainEffects),
    ),
    {
      outcome: "terminal_failure",
      safeFailureCode: "RELEASE_RECONCILIATION_REQUIRED",
    },
  );
  assert.equal(uncertain.outcomes.promotions, 0);

  const ambiguous = fixture([health("ambiguous")]);
  assert.deepEqual(
    await ambiguous.handler.invoke(
      context(ambiguous.manifests, new MemorySideEffects()),
    ),
    {
      outcome: "terminal_failure",
      safeFailureCode: "RELEASE_EVIDENCE_AMBIGUOUS",
    },
  );

  const stale = fixture([health("healthy")]);
  assert.deepEqual(
    await stale.handler.invoke(
      context(stale.manifests, new MemorySideEffects(), () => false),
    ),
    {
      outcome: "terminal_failure",
      safeFailureCode: "RELEASE_OWNERSHIP_LOST",
    },
  );
  assert.equal(stale.client.registerCalls, 0);
  assert.equal(stale.client.updateCalls, 0);

  const cancelled = fixture([health("healthy")]);
  const cancellation = new AbortController();
  cancellation.abort();
  assert.deepEqual(
    await cancelled.handler.invoke(
      context(
        cancelled.manifests,
        new MemorySideEffects(),
        () => true,
        cancellation.signal,
      ),
    ),
    {
      outcome: "terminal_failure",
      safeFailureCode: "RELEASE_OWNERSHIP_LOST",
    },
  );
  assert.equal(cancelled.client.registerCalls, 0);
  assert.equal(cancelled.client.updateCalls, 0);

  const registryFixture = fixture([health("healthy")]);
  const registry = buildV1InactiveReleaseHandlerRegistry(
    registryFixture.handler,
  );
  assert.equal(
    registry.get("intent.release.execute"),
    registryFixture.handler,
  );
  assert.equal(registry.size, 4);
  assert.equal(
    registryFixture.handler.releasePolicy,
    "deployguard.release-handler/inactive-ecs-release-v1",
  );
  assert.throws(
    () => buildV1InactiveReleaseHandlerRegistry({
      ...registryFixture.handler,
      releasePolicy: "wrong-policy",
    } as any),
    /Invalid inactive v1 release handler/,
  );

  const releasePath =
    "src/orchestration-contracts/worker-runtime/";
  const handlerSource = readFileSync(
    releasePath + "inactive-v1-ecs-release-handler.ts",
    "utf8",
  );
  for (const forbidden of [
    "Terraform",
    "terraform",
    "runInfrastructure",
    "createService",
    "CreateServiceCommand",
    "CreateClusterCommand",
    "CreateLoadBalancerCommand",
  ]) {
    assert.equal(
      handlerSource.includes(forbidden),
      false,
      `forbidden release dependency: ${forbidden}`,
    );
  }
  for (const reachableFile of [
    "inactive-v1-ecs-release-handler.ts",
    "inactive-v1-ecs-release-mutation.adapter.ts",
    "inactive-v1-ecs-release-outcome.coordinator.ts",
    "inactive-v1-ecs-release-outcome.store.ts",
    "inactive-v1-stable-release-projection.store.ts",
    "disabled-v1-ecs-mutation.client.ts",
    "disabled-v1-ecs-rollout-health.verifier.ts",
  ]) {
    const source = readFileSync(releasePath + reachableFile, "utf8");
    for (const forbiddenImport of [
      "terraform-runner",
      "InfrastructureService",
      "StateLockService",
      "intent.infrastructure.plan",
      "intent.infrastructure.apply",
      "intent.deletion.execute",
    ]) {
      assert.equal(
        source.includes(forbiddenImport),
        false,
        `${reachableFile} reaches ${forbiddenImport}`,
      );
    }
  }
  const moduleSource = readFileSync(
    "src/orchestration-contracts/orchestration-contracts.module.ts",
    "utf8",
  );
  assert.equal(
    moduleSource.includes("InactiveV1EcsReleaseHandler"),
    false,
  );
  assert.equal(
    InactiveV1EcsReleaseManifestStore.name.length > 0,
    true,
  );
  console.log("Inactive v1 ECS release handler checks passed.");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
