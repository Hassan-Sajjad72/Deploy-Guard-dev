import { strict as assert } from "node:assert";
import { ConfigService } from "@nestjs/config";
import { ECRClient } from "@aws-sdk/client-ecr";
import { ECSClient } from "@aws-sdk/client-ecs";
import { canonicalSha256 } from "../src/orchestration-contracts/contracts/canonical-json";
import {
  workerEnvelopeJobId,
  workerEnvelopePayloadForHash,
} from "../src/orchestration-contracts/contracts/worker-envelope.validator";
import { DeployGuardWorkerEnvelopeV1 } from "../src/orchestration-contracts/contracts/worker-envelope.types";
import { FrozenProtocolQueue } from "../src/orchestration-contracts/outbox/frozen-bullmq-job.adapter";
import {
  NormalReleaseLaneConvergenceService,
} from "../src/orchestration-contracts/release-lane/normal-release-lane-convergence.service";

const intentId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const candidateId = "33333333-3333-4333-8333-333333333333";
const infrastructureId = "44444444-4444-4444-8444-444444444444";
const stableManifestId = "55555555-5555-4555-8555-555555555555";
const previousStableManifestId = "66666666-6666-4666-8666-666666666666";
const serviceOwningManifestId = "77777777-7777-4777-8777-777777777777";
const digest = `sha256:${"a".repeat(64)}`;
const task = "arn:aws:ecs:us-east-1:123456789012:task-definition/app:7";
const cluster = "arn:aws:ecs:us-east-1:123456789012:cluster/app";
const service = "arn:aws:ecs:us-east-1:123456789012:service/app";
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
    serviceVersion: "1.0.0",
    gitSha: "b".repeat(40),
    producedAt: new Date().toISOString(),
  },
  identity: {
    intentId,
    projectId,
    environmentName: "dev",
    pipelineRunId: null,
    destroyOperationId: null,
    infrastructureManifestId: infrastructureId,
    releaseManifestId: candidateId,
  },
  routing: {
    lane: "release",
    operation: "execute",
    queue: "deployguard-release-v1",
  },
  idempotency: {
    canonicalKey: "c".repeat(64),
    payloadSha256: "",
    attempt: 1,
    replayOfJobId: null,
  },
  execution: {
    mode: "full",
    resumeFromStage: null,
    reusableCheckpointIds: [],
    invalidatedCheckpointIds: [],
    reasonCodes: ["NEW_RELEASE"],
    fencingTokenRequired: true,
  },
  trace: {
    correlationId: "normal-release-convergence-test",
    causationId: null,
    actorUserId: 1,
  },
  expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
};
envelope.idempotency.payloadSha256 = canonicalSha256(
  workerEnvelopePayloadForHash(envelope),
);
const jobId = workerEnvelopeJobId(envelope);

function config(enabled: boolean) {
  const values: Record<string, unknown> = {
    TWO_LANE_NORMAL_RELEASE_OUTCOME_RECONCILE_APPROVED:
      enabled ? "true" : "false",
    TWO_LANE_RELEASE_PROJECT_ALLOWLIST: projectId,
    TWO_LANE_RELEASE_ENVIRONMENT_ALLOWLIST: "dev",
    AWS_REGION: "us-east-1",
    OUTBOX_BULLMQ_PREFIX: "test",
  };
  return {
    get(key: string, fallback?: unknown) {
      return values[key] ?? fallback;
    },
  } as ConfigService;
}

async function run() {
  let disabledQueries = 0;
  const disabled = new NormalReleaseLaneConvergenceService({
    query: async () => {
      disabledQueries += 1;
      throw new Error("must not query");
    },
  } as any, config(false));
  assert.equal(
    (await disabled.reconcileExact(projectId, intentId)).safeCodes[0],
    "NORMAL_RELEASE_CONVERGENCE_DISABLED",
  );
  assert.equal(disabledQueries, 0);

  let transactionCount = 0;
  let retryCount = 0;
  let evidenceQueries = 0;
  let lineageDepth = 0;
  const dataSource = {
    query: async (sql: string) => {
      evidenceQueries += 1;
      if (sql.includes("FROM deployment_intents intent")) {
        lineageDepth = 0;
        return [{
          intentId,
          projectId,
          actorId: 1,
          candidateId,
          candidateDigest: digest,
          candidateTaskDefinitionArn: task,
          infrastructureId,
          stableId: stableManifestId,
          stablePreviousManifestId: previousStableManifestId,
          clusterArn: cluster,
          serviceArn: null,
          ecrRepositoryName: "repository",
          publishedJobId: jobId,
          status: "failed",
          failureCode: "RELEASE_EVIDENCE_AMBIGUOUS",
        }];
      }
      lineageDepth += 1;
      if (lineageDepth === 1) {
        return [{
          id: previousStableManifestId,
          previousStableManifestId: serviceOwningManifestId,
          initialServiceArn: null,
        }];
      }
      return [{
        id: serviceOwningManifestId,
        previousStableManifestId: null,
        initialServiceArn: service,
      }];
    },
    transaction: async (_isolation: string, callback: (manager: any) => unknown) => {
      transactionCount += 1;
      let step = 0;
      return callback({
        query: async () => {
          step += 1;
          if (step === 1) return [];
          if (step === 2) {
            return [{
              status: "failed",
              failureCode: "RELEASE_EVIDENCE_AMBIGUOUS",
            }];
          }
          if (step === 3) return [{ id: intentId }];
          return [];
        },
      });
    },
    createQueryRunner: () => {
      const runner = {
        isReleased: false,
        connect: async () => undefined,
        query: async () => [],
        release: async () => {
          runner.isReleased = true;
        },
      };
      return runner;
    },
  };
  const originalEcrSend = ECRClient.prototype.send;
  const originalEcsSend = ECSClient.prototype.send;
  const originalGetJob = FrozenProtocolQueue.prototype.getJob;
  let jobState: "failed" | "waiting" = "failed";
  let jobTimestamp = Date.now();
  (ECRClient.prototype as any).send = async () => ({
    imageDetails: [{ imageDigest: digest }],
  });
  (ECSClient.prototype as any).send = async () => ({
    failures: [],
    services: [{
      status: "ACTIVE",
      clusterArn: cluster,
      serviceArn: service,
      taskDefinition: task,
      runningCount: 1,
      desiredCount: 1,
      pendingCount: 0,
      deployments: [{
        status: "PRIMARY",
        taskDefinition: task,
        rolloutState: "COMPLETED",
      }],
    }],
  });
  (FrozenProtocolQueue.prototype as any).getJob = async () => ({
    data: envelope,
    failedReason: "RELEASE_EVIDENCE_AMBIGUOUS",
    attemptsMade: 1,
    get timestamp() {
      return jobTimestamp;
    },
    getState: async () => jobState,
    retry: async () => {
      retryCount += 1;
    },
  });
  try {
    const serviceUnderTest = new NormalReleaseLaneConvergenceService(
      dataSource as any,
      config(true),
    );
    const result = await serviceUnderTest.reconcileExact(projectId, intentId);
    assert.equal(result.state, "resumed");
    assert.equal(evidenceQueries, 3);
    assert.equal(transactionCount, 1);
    assert.equal(retryCount, 1);

    // A second scheduler/process observation after the first retry has moved
    // the exact frozen job back to delivery is an idempotent resume, not a
    // second BullMQ retry.
    jobState = "waiting";
    const alreadyScheduled = await serviceUnderTest.reconcileExact(
      projectId,
      intentId,
    );
    assert.equal(alreadyScheduled.state, "resumed");
    assert.equal(transactionCount, 1);
    assert.equal(retryCount, 1);
    jobState = "failed";

    // Expired, still-failed evidence terminates locally before any additional
    // external inspection or retry; a permanently inconclusive rollout cannot
    // keep the supervised scheduler alive indefinitely.
    jobTimestamp = Date.now() - 60_001;
    const exhausted = await serviceUnderTest.reconcileExact(
      projectId,
      intentId,
      { maxAttempts: 2, maxElapsedMs: 60_000 },
    );
    assert.equal(exhausted.state, "exhausted");
    assert.equal(exhausted.safeCodes[0], "NORMAL_RELEASE_CONVERGENCE_BOUND_EXHAUSTED");
    assert.equal(retryCount, 1);
    jobTimestamp = Date.now();

    (ECSClient.prototype as any).send = async () => ({
      failures: [],
      services: [],
    });
    const blocked = await serviceUnderTest.reconcileExact(projectId, intentId);
    assert.equal(
      blocked.safeCodes[0],
      "NORMAL_RELEASE_CONVERGENCE_NOT_PROVEN",
    );
    assert.equal(transactionCount, 2);
    assert.equal(retryCount, 1);
  } finally {
    (ECRClient.prototype as any).send = originalEcrSend;
    (ECSClient.prototype as any).send = originalEcsSend;
    (FrozenProtocolQueue.prototype as any).getJob = originalGetJob;
  }
  console.log("Normal release lane convergence verification passed");
}

run();
