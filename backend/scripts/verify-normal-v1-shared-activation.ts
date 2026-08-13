import { strict as assert } from "node:assert";
import { ConfigService } from "@nestjs/config";
import { canonicalSha256 } from "../src/orchestration-contracts/contracts/canonical-json";
import { DeployGuardWorkerEnvelopeV1 } from "../src/orchestration-contracts/contracts/worker-envelope.types";
import {
  validateWorkerEnvelopeV1,
  workerEnvelopePayloadForHash,
} from "../src/orchestration-contracts/contracts/worker-envelope.validator";
import {
  normalV1Activation,
  normalV1AllowsScope,
} from "../src/orchestration-contracts/release-lane/normal-v1-activation-policy";
import { V1InfrastructureManifestPlanService } from "../src/orchestration-contracts/infrastructure/v1-infrastructure-manifest-plan.service";
import { V1InfrastructureManifestApplyService } from "../src/orchestration-contracts/infrastructure/v1-infrastructure-manifest-apply.service";
import {
  NormalReleaseLaneAutoConvergenceScheduler,
} from "../src/orchestration-contracts/worker-runtime/normal-release-lane-auto-convergence.scheduler";
import {
  InactiveV1WorkerRuntimeError,
} from "../src/orchestration-contracts/worker-runtime/inactive-v1-worker-runtime.types";
import {
  InactiveV1WorkerRuntimeService,
} from "../src/orchestration-contracts/worker-runtime/inactive-v1-worker-runtime.service";
import {
  assertV1ConsumerJobScope,
  canonicalizeV1ConsumerStart,
} from "../src/orchestration-contracts/worker-runtime/v1-bullmq-consumer.pure";

const firstProjectId = "11111111-1111-4111-8111-111111111111";
const secondProjectId = "22222222-2222-4222-8222-222222222222";
const intentId = "33333333-3333-4333-8333-333333333333";

function config(overrides: Record<string, unknown> = {}) {
  return new ConfigService({
    TWO_LANE_NORMAL_V1_OPERATING_MODE: "shared",
    TWO_LANE_RELEASE_COMPOSITION_MODE: "production_shared",
    // A stale canary value must not bind a shared worker.
    TWO_LANE_RELEASE_PROJECT_ALLOWLIST: firstProjectId,
    TWO_LANE_RELEASE_ENVIRONMENT_ALLOWLIST: "dev",
    TWO_LANE_OWNERSHIP_ENVIRONMENT_ALLOWLIST: "dev",
    TWO_LANE_NORMAL_RELEASE_AUTO_CONVERGENCE_ENABLED: "true",
    TWO_LANE_NORMAL_RELEASE_OUTCOME_RECONCILE_APPROVED: "true",
    TWO_LANE_NORMAL_RELEASE_AUTO_CONVERGENCE_INTERVAL_MS: "1000",
    TWO_LANE_NORMAL_RELEASE_AUTO_CONVERGENCE_MAX_ATTEMPTS: "2",
    TWO_LANE_NORMAL_RELEASE_AUTO_CONVERGENCE_MAX_ELAPSED_MS: "60000",
    ...overrides,
  });
}

function sharedEnvelope(): DeployGuardWorkerEnvelopeV1 {
  const envelope: DeployGuardWorkerEnvelopeV1 = {
    protocol: {
      name: "deployguard.worker",
      schemaVersion: 1,
      messageType: "intent.release.execute",
      minimumWorkerProtocol: 1,
      maximumWorkerProtocol: 1,
    },
    producer: {
      service: "deployguard-api",
      serviceVersion: "shared-test",
      gitSha: "a".repeat(40),
      producedAt: "2026-08-01T12:00:00.000Z",
    },
    identity: {
      workspaceId: "workspace:7",
      intentId,
      projectId: secondProjectId,
      environmentName: "dev",
      pipelineRunId: null,
      destroyOperationId: null,
      infrastructureManifestId: "44444444-4444-4444-8444-444444444444",
      releaseManifestId: "55555555-5555-4555-8555-555555555555",
    },
    authorization: {
      actorUserId: 7,
      actorRole: "developer",
      projectOwnerUserId: 7,
      policySnapshotSha256: canonicalSha256({
        workspaceId: "workspace:7",
        projectId: secondProjectId,
        environmentName: "dev",
        actorUserId: 7,
        actorRole: "developer",
        projectOwnerUserId: 7,
      }),
    },
    expectations: {
      sourceCommitSha: "b".repeat(40),
      deploymentContractHash: "c".repeat(64),
      infrastructureRevision: "4",
      releaseRevision: "9",
      awsAccountId: "123456789012",
      awsRegion: "us-east-1",
      resourceNamespace: "dg-222222222222-dev",
    },
    routing: {
      lane: "release",
      operation: "execute",
      queue: "deployguard-release-v1",
    },
    idempotency: {
      canonicalKey: "d".repeat(64),
      payloadSha256: "0".repeat(64),
      attempt: 1,
      replayOfJobId: null,
    },
    execution: {
      mode: "full",
      resumeFromStage: null,
      reusableCheckpointIds: [],
      invalidatedCheckpointIds: [],
      reasonCodes: ["SOURCE_CHANGED"],
      fencingTokenRequired: true,
    },
    trace: {
      correlationId: intentId,
      causationId: null,
      actorUserId: 7,
    },
    expiresAt: "2026-08-01T13:00:00.000Z",
  };
  envelope.idempotency.payloadSha256 = canonicalSha256(
    workerEnvelopePayloadForHash(envelope),
  );
  return envelope;
}

async function waitFor(condition: () => boolean) {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for shared convergence observation.");
}

async function run() {
  const shared = config();
  assert.deepEqual(normalV1Activation(shared), {
    mode: "shared",
    environmentNames: ["dev"],
    projectIds: [],
  });
  assert.equal(normalV1AllowsScope(shared, firstProjectId, "dev"), true);
  assert.equal(normalV1AllowsScope(shared, secondProjectId, "dev"), true);
  assert.equal(normalV1AllowsScope(shared, secondProjectId, "staging"), false);
  assert.equal(normalV1AllowsScope(shared, "*", "dev"), false);

  const sharedInfrastructure = config({
    TWO_LANE_NORMAL_INFRASTRUCTURE_PLAN_EXECUTION_ENABLED: "true",
    TWO_LANE_EXPECTED_AWS_ACCOUNT_ID: "123456789012",
    TERRAFORM_STATE_BUCKET: "deployguard-state",
    TERRAFORM_STATE_REGION: "us-east-1",
    TERRAFORM_STATE_PREFIX: "projects",
    TERRAFORM_STATE_USE_LOCKFILE: "true",
  });
  const planService = new V1InfrastructureManifestPlanService(
    {} as never,
    sharedInfrastructure,
    {} as never,
  );
  const sharedManifest = {
    projectId: secondProjectId,
    environmentName: "dev",
    revision: "1",
    stateBackend: "s3",
    stateKey: `projects/${secondProjectId}/dev/v1/1.tfstate`,
  };
  assert.equal((planService as any).remotePlanAllowed(sharedManifest), true);
  assert.equal((planService as any).expectedAwsAccount(), "123456789012");
  assert.equal((planService as any).remotePlanAllowed({
    ...sharedManifest,
    environmentName: "staging",
    stateKey: `projects/${secondProjectId}/staging/v1/1.tfstate`,
  }), false);
  assert.equal((new V1InfrastructureManifestPlanService(
    {} as never,
    config({
      TWO_LANE_EXPECTED_AWS_ACCOUNT_ID: "123456789012",
      TERRAFORM_STATE_BUCKET: "deployguard-state",
      TERRAFORM_STATE_REGION: "us-east-1",
      TERRAFORM_STATE_USE_LOCKFILE: "true",
      TWO_LANE_REMOTE_CANARY_PLAN_ENABLED: "true",
      TWO_LANE_CANARY_COST_DEFERRED_ACKNOWLEDGED: "true",
      TWO_LANE_CANARY_COST_MODE: "deferred_canary",
      TWO_LANE_CANARY_PROJECT_ID: secondProjectId,
      TWO_LANE_CANARY_ENVIRONMENT: "dev",
      STATE_MOCK_MODE: "false",
    }),
    {} as never,
  ) as any).remotePlanAllowed(sharedManifest), false, "shared remote planning remains default-off");
  const applyService = new V1InfrastructureManifestApplyService(
    {} as never,
    sharedInfrastructure,
    {} as never,
    {} as never,
  );
  assert.equal((applyService as any).expectedAwsAccount(), "123456789012");

  const canary = config({
    TWO_LANE_NORMAL_V1_OPERATING_MODE: "canary",
    TWO_LANE_RELEASE_COMPOSITION_MODE: "production_canary",
  });
  assert.equal(normalV1AllowsScope(canary, firstProjectId, "dev"), true);
  assert.equal(normalV1AllowsScope(canary, secondProjectId, "dev"), false);

  const capability = {
    workerId: "shared-release-worker",
    role: "release" as const,
    supportedMessageTypes: ["intent.release.execute" as const],
    serviceVersion: "shared-test",
    gitSha: "local",
    heartbeatTtlMs: 60_000,
  };
  const start = canonicalizeV1ConsumerStart({
    capability,
    connection: { host: "127.0.0.1", port: 6379 },
    prefix: "shared-test",
    scope: {
      mode: "shared",
      projectIds: [],
      environmentNames: ["dev"],
    },
  });
  assert.deepEqual(start.scope, {
    mode: "shared",
    projectIds: [],
    environmentNames: ["dev"],
  });
  assert.throws(() => canonicalizeV1ConsumerStart({
    capability,
    connection: { host: "127.0.0.1", port: 6379 },
    prefix: "shared-test",
    scope: {
      mode: "shared",
      projectIds: [firstProjectId],
      environmentNames: ["dev"],
    },
  }), /CONSUMER_CONFIG_INVALID/);

  const envelope = sharedEnvelope();
  assert.doesNotThrow(() => assertV1ConsumerJobScope(start.scope, envelope));
  const legacyEnvelope = structuredClone(envelope);
  delete legacyEnvelope.identity.workspaceId;
  delete legacyEnvelope.authorization;
  delete legacyEnvelope.expectations;
  legacyEnvelope.idempotency.payloadSha256 = canonicalSha256(
    workerEnvelopePayloadForHash(legacyEnvelope),
  );
  assert.throws(
    () => assertV1ConsumerJobScope(start.scope, legacyEnvelope),
    /CONSUMER_JOB_SCOPE_NOT_ALLOWED/,
  );
  assert.equal(
    validateWorkerEnvelopeV1(envelope, new Date("2026-08-01T12:01:00.000Z")),
    envelope,
  );
  const substituted = structuredClone(envelope);
  substituted.identity.projectId = firstProjectId;
  substituted.idempotency.payloadSha256 = canonicalSha256(
    workerEnvelopePayloadForHash(substituted),
  );
  // Shape/hash validation alone cannot authorize a substitution; the runtime
  // revalidates this snapshot against the durable intent before ownership.
  assert.notEqual(
    substituted.authorization?.policySnapshotSha256,
    canonicalSha256({
      workspaceId: "workspace:7",
      projectId: firstProjectId,
      environmentName: "dev",
      actorUserId: 7,
      actorRole: "developer",
      projectOwnerUserId: 7,
    }),
  );
  assert.throws(() => validateWorkerEnvelopeV1({
    ...envelope,
    authorization: undefined,
  }, new Date("2026-08-01T12:01:00.000Z")), /object|shape/);

  const runtimeEnvelope = structuredClone(envelope);
  runtimeEnvelope.producer.producedAt = new Date().toISOString();
  runtimeEnvelope.expiresAt = new Date(Date.now() + 60_000).toISOString();
  runtimeEnvelope.idempotency.payloadSha256 = canonicalSha256(
    workerEnvelopePayloadForHash(runtimeEnvelope),
  );
  const runtimeConfig = new ConfigService({
    TWO_LANE_EXPECTED_AWS_ACCOUNT_ID: "123456789012",
    AWS_REGION: "us-east-1",
  });
  let durableReads = 0;
  const runtime = new InactiveV1WorkerRuntimeService(
    {
      async query() {
        durableReads += 1;
        return [{
          id: intentId,
          requestedByUserId: 7,
          requestedByRole: "developer",
          projectId: secondProjectId,
          environmentName: "dev",
          classification: "release_only",
          status: "enqueued",
          canonicalIdempotencyKey: "d".repeat(64),
          infrastructureManifestId: "44444444-4444-4444-8444-444444444444",
          releaseManifestId: "55555555-5555-4555-8555-555555555555",
          pipelineRunId: null,
          destroyOperationId: null,
          projectOwnerUserId: 7,
          projectStatus: "active",
          projectArchivedAt: null,
          contractCommitSha: "b".repeat(40),
          contractHash: "c".repeat(64),
          contractDeployable: true,
          contractInvalidatedAt: null,
          preflightFingerprint: "c".repeat(64),
          preflightStatus: "passed",
          infrastructureRevision: "4",
          releaseRevision: "9",
          createdAt: new Date(),
          projectDeletionFenceToken: null,
          projectDeletionIntentId: null,
          projectDeletionStartedAt: null,
          releaseManifestStatus: "deploying",
          infrastructureManifestStatus: "applied",
          hasNewerAcceptedIntent: false,
        }];
      },
    } as never,
    {
      async requireLiveCompatible() {
        return undefined;
      },
    } as never,
    runtimeConfig,
  );
  const validated = await runtime.validate({
    workerId: "shared-release-worker",
    queueName: "deployguard-release-v1",
    envelope: runtimeEnvelope,
  });
  assert.equal(validated.disposition, "validated");
  assert.equal(durableReads, 1);

  const wrongWorkspace = structuredClone(runtimeEnvelope);
  wrongWorkspace.identity.workspaceId = "workspace:9";
  wrongWorkspace.authorization!.actorUserId = 9;
  wrongWorkspace.authorization!.projectOwnerUserId = 9;
  wrongWorkspace.authorization!.policySnapshotSha256 = canonicalSha256({
    workspaceId: "workspace:9",
    projectId: secondProjectId,
    environmentName: "dev",
    actorUserId: 9,
    actorRole: "developer",
    projectOwnerUserId: 9,
  });
  wrongWorkspace.idempotency.payloadSha256 = canonicalSha256(
    workerEnvelopePayloadForHash(wrongWorkspace),
  );
  await assert.rejects(
    () => runtime.validate({
      workerId: "shared-release-worker",
      queueName: "deployguard-release-v1",
      envelope: wrongWorkspace,
    }),
    (error: unknown) => error instanceof InactiveV1WorkerRuntimeError
      && error.code === "WORKER_AUTHORIZATION_INVALID",
  );

  let observations = 0;
  let reconciliations = 0;
  const scheduler = new NormalReleaseLaneAutoConvergenceScheduler(
    shared,
    {
      async findAutomaticCandidateAcrossProjects() {
        observations += 1;
        return observations === 1
          ? { projectId: secondProjectId, intentId }
          : null;
      },
      async reconcileExact(
        observedProjectId: string,
        observedIntentId: string,
        bounds: { maxAttempts: number; maxElapsedMs: number },
      ) {
        reconciliations += 1;
        assert.equal(observedProjectId, secondProjectId);
        assert.equal(observedIntentId, intentId);
        assert.deepEqual(bounds, { maxAttempts: 2, maxElapsedMs: 60_000 });
        return {
          state: "resumed" as const,
          safeCodes: ["NORMAL_RELEASE_CONVERGENCE_RESUMED"] as [string],
        };
      },
    } as never,
  );
  assert.equal(scheduler.start(null).state, "idle");
  await waitFor(() => reconciliations === 1);
  assert.equal(observations, 1);
  await scheduler.stop();
  assert.equal(scheduler.getStatus().state, "stopped");

  process.stdout.write("Normal-v1 shared activation verification passed\n");
}

void run().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
