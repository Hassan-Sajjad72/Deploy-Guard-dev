import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { canonicalSha256 } from "../src/orchestration-contracts/contracts/canonical-json";
import { InactiveV1EcsReleaseOutcomeCoordinator } from
  "../src/orchestration-contracts/worker-runtime/inactive-v1-ecs-release-outcome.coordinator";
import {
  candidateOutcomeFingerprint,
  deriveRollbackIdempotencyKey,
} from "../src/orchestration-contracts/worker-runtime/inactive-v1-ecs-release-outcome.pure";
import {
  V1EcsReleaseOutcomeError,
  V1EcsReleaseOutcomeStore,
} from "../src/orchestration-contracts/worker-runtime/inactive-v1-ecs-release-outcome.types";
import {
  V1EcsReleaseManifestStore,
  V1EcsReleaseMutationClient,
} from "../src/orchestration-contracts/worker-runtime/inactive-v1-ecs-release-mutation.types";
import {
  V1EcsRolloutHealthVerificationResult,
  V1EcsRolloutHealthVerifier,
} from "../src/orchestration-contracts/worker-runtime/inactive-v1-ecs-rollout-health.types";
import {
  V1HandlerSideEffectBoundary,
  V1HandlerSideEffectSnapshot,
} from "../src/orchestration-contracts/worker-runtime/v1-handler-side-effect.types";

const projectId = "11111111-1111-4111-8111-111111111111";
const releaseManifestId = "22222222-2222-4222-8222-222222222222";
const infrastructureManifestId =
  "33333333-3333-4333-8333-333333333333";
const intentId = "44444444-4444-4444-8444-444444444444";
const leaseId = "55555555-5555-4555-8555-555555555555";
const operationId = "66666666-6666-4666-8666-666666666666";
const previousStableId = "77777777-7777-4777-8777-777777777777";
const rollbackManifestId =
  "88888888-8888-4888-8888-888888888888";
const clusterArn =
  "arn:aws:ecs:us-east-1:123456789012:cluster/deployguard-project";
const serviceArn =
  "arn:aws:ecs:us-east-1:123456789012:service/deployguard-project/app";
const taskDefinitionArn =
  "arn:aws:ecs:us-east-1:123456789012:task-definition/app:7";

const revision = {
  projectId,
  environmentName: "production",
  releaseManifestId,
  releaseRevision: "9",
  infrastructureManifestId,
  infrastructureRevision: "4",
};
const fence = {
  intentId,
  leaseId,
  workerId: "fixture-worker",
  fencingToken: "12",
};

function verification(
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

class FixtureVerifier implements V1EcsRolloutHealthVerifier {
  readonly policy =
    "deployguard.ecs-rollout-health/disabled-read-only-v1" as const;
  calls = 0;
  constructor(
    private readonly results: V1EcsRolloutHealthVerificationResult[],
  ) {}
  async verify() {
    const result = this.results[this.calls++];
    assert.ok(result, "unexpected verifier invocation");
    return result;
  }
}

class FixtureOutcomeStore implements V1EcsReleaseOutcomeStore {
  promotions = 0;
  preparations = 0;
  finalizations = 0;
  missing = false;
  async promoteCandidate(input: any) {
    this.promotions += 1;
    assert.equal(input.fence.fencingToken, "12");
    return {
      disposition: this.promotions === 1 ? "promoted" : "replayed",
    } as const;
  }
  async prepareRollback(input: any) {
    this.preparations += 1;
    assert.equal(
      input.inputFingerprint,
      candidateOutcomeFingerprint(revision, input.candidateVerification),
    );
    if (this.missing) {
      return {
        disposition: "rollback_target_missing",
        safeCode: "ECS_PREVIOUS_STABLE_RELEASE_MISSING",
      } as const;
    }
    return {
      disposition: this.preparations === 1
        ? "rollback_prepared"
        : "rollback_replayed",
      target: {
        rollbackManifestId,
        rollbackRevision: "10",
        previousStable: {
          ...revision,
          releaseManifestId: previousStableId,
          releaseRevision: "8",
          taskDefinitionArn,
        },
        clusterArn,
        serviceArn,
        inputFingerprint: input.inputFingerprint,
      },
    } as const;
  }
  async finalizeRollback(input: any) {
    this.finalizations += 1;
    assert.equal(input.previousStableManifestId, previousStableId);
    return {
      disposition: this.finalizations === 1
        ? "rolled_back"
        : "replayed",
    } as const;
  }
}

class FixtureMutationClient implements V1EcsReleaseMutationClient {
  readonly policy = "deployguard.ecs-release-mutation/client-v1" as const;
  updates = 0;
  async registerTaskDefinitionRevision(): Promise<any> {
    throw new Error("registration must not be reachable");
  }
  async updateExistingService(request: any, ownership: any) {
    this.updates += 1;
    assert.equal(request.clusterArn, clusterArn);
    assert.equal(request.serviceArn, serviceArn);
    assert.equal(request.taskDefinitionArn, taskDefinitionArn);
    assert.equal(ownership.fencingToken, fence.fencingToken);
    return { serviceArn };
  }
}

const manifests: V1EcsReleaseManifestStore = {
  async loadExact() {
    return null;
  },
  async recordTaskDefinitionReference(): Promise<any> {
    throw new Error("not reachable");
  },
};

function sideEffects(
  mutationClient: FixtureMutationClient,
  trusted = () => true,
): V1HandlerSideEffectBoundary {
  let snapshot: V1HandlerSideEffectSnapshot | null = null;
  return {
    async execute(request) {
      const controller = new AbortController();
      const outcome = await request.perform({
        ...fence,
        projectId,
        environmentName: "production",
        operationId: request.operationId,
        idempotencyKey: request.idempotencyKey,
        effectType: request.effectType,
        inputFingerprint: request.inputFingerprint,
        signal: controller.signal,
        deadlineAt: new Date(Date.now() + 5_000),
        isLeaseTrusted: trusted,
      });
      assert.equal(outcome.outcome, "succeeded");
      snapshot = {
        id: "99999999-9999-4999-8999-999999999999",
        ...fence,
        projectId,
        environmentName: "production",
        operationId: request.operationId,
        effectType: request.effectType,
        idempotencyKey: request.idempotencyKey,
        requestFingerprint: request.inputFingerprint,
        status: "succeeded",
        safeResultCode: outcome.outcome === "succeeded"
          ? outcome.safeResultCode
          : null,
        resultFingerprint: outcome.outcome === "succeeded"
          ? outcome.resultFingerprint
          : null,
        externalReferenceHash: null,
        failureCode: null,
        reconciliationRequired: false,
        attemptStartedAt: new Date(),
        deadlineAt: new Date(Date.now() + 5_000),
        completedAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      return { disposition: "executed", effect: snapshot };
    },
    finalizationStatus() {
      return trusted()
        ? { allowed: true, safeFailureCode: null }
        : {
            allowed: false,
            safeFailureCode: "SIDE_EFFECT_OWNERSHIP_LOST",
          };
    },
  };
}

function input(
  boundary: V1HandlerSideEffectBoundary,
  trusted = () => true,
) {
  return {
    revision,
    idempotencyKey: "a".repeat(64),
    rollbackOperationId: operationId,
    timeoutMs: 5_000,
    candidateDeadlineAt: new Date(Date.now() + 5_000),
    rollbackDeadlineAt: new Date(Date.now() + 10_000),
    execution: {
      signal: new AbortController().signal,
      isLeaseTrusted: trusted,
    },
    sideEffects: boundary,
    fence,
  };
}

async function run(
  results: V1EcsRolloutHealthVerificationResult[],
) {
  const outcomes = new FixtureOutcomeStore();
  const mutation = new FixtureMutationClient();
  const verifier = new FixtureVerifier(results);
  const coordinator = new InactiveV1EcsReleaseOutcomeCoordinator({
    manifests,
    outcomes,
    mutationClient: mutation,
    verifier,
  });
  const boundary = sideEffects(mutation);
  return {
    result: await coordinator.coordinate(input(boundary)),
    outcomes,
    mutation,
    verifier,
  };
}

void (async () => {
  const healthy = await run([verification("healthy")]);
  assert.equal(healthy.result.disposition, "candidate_promoted");
  assert.equal(healthy.outcomes.promotions, 1);
  assert.equal(healthy.mutation.updates, 0);

  const progressing = await run([verification("progressing")]);
  assert.equal(progressing.result.disposition, "candidate_progressing");
  assert.equal(progressing.outcomes.promotions, 0);
  assert.equal(progressing.outcomes.preparations, 0);

  const ambiguous = await run([verification("ambiguous")]);
  assert.equal(ambiguous.result.disposition, "manual_review_required");
  assert.equal(ambiguous.mutation.updates, 0);

  const rollback = await run([
    verification("failed"),
    verification("healthy"),
  ]);
  assert.equal(rollback.result.disposition, "rollback_completed");
  assert.equal(rollback.mutation.updates, 1);
  assert.equal(rollback.outcomes.finalizations, 1);
  assert.equal(rollback.verifier.calls, 2);

  const pending = await run([
    verification("timed_out"),
    verification("progressing"),
  ]);
  assert.equal(
    pending.result.disposition,
    "rollback_verification_pending",
  );
  assert.equal(pending.outcomes.finalizations, 0);

  const outcomes = new FixtureOutcomeStore();
  outcomes.missing = true;
  const mutation = new FixtureMutationClient();
  const missing = new InactiveV1EcsReleaseOutcomeCoordinator({
    manifests,
    outcomes,
    mutationClient: mutation,
    verifier: new FixtureVerifier([verification("failed")]),
  });
  const missingResult = await missing.coordinate(
    input(sideEffects(mutation)),
  );
  assert.equal(missingResult.disposition, "rollback_target_missing");
  assert.equal(mutation.updates, 0);

  let trusted = true;
  const lostOutcomes = new FixtureOutcomeStore();
  const lostMutation = new FixtureMutationClient();
  class LosingClient extends FixtureMutationClient {
    async updateExistingService(request: any, ownership: any) {
      const result = await super.updateExistingService(request, ownership);
      trusted = false;
      return result;
    }
  }
  const losingClient = new LosingClient();
  const lost = new InactiveV1EcsReleaseOutcomeCoordinator({
    manifests,
    outcomes: lostOutcomes,
    mutationClient: losingClient,
    verifier: new FixtureVerifier([verification("failed")]),
  });
  await assert.rejects(
    lost.coordinate(input(sideEffects(losingClient, () => trusted),
      () => trusted)),
    (error: unknown) =>
      error instanceof V1EcsReleaseOutcomeError
      && error.code === "ECS_RELEASE_OUTCOME_OWNERSHIP_LOST",
  );
  assert.equal(lostOutcomes.finalizations, 0);

  assert.notEqual(
    deriveRollbackIdempotencyKey("a".repeat(64)),
    "a".repeat(64),
  );
  const moduleSource = readFileSync(
    "src/orchestration-contracts/orchestration-contracts.module.ts",
    "utf8",
  );
  const appSource = readFileSync("src/app.module.ts", "utf8");
  assert.equal(
    moduleSource.includes("InactiveV1EcsReleaseOutcomeCoordinator"),
    false,
  );
  assert.equal(
    appSource.includes("InactiveV1EcsReleaseOutcomeCoordinator"),
    false,
  );
  const malformed = new InactiveV1EcsReleaseOutcomeCoordinator({
    manifests,
    outcomes: new FixtureOutcomeStore(),
    mutationClient: new FixtureMutationClient(),
    verifier: new FixtureVerifier([{
      status: "healthy",
      safeCode: "ECS_ROLLOUT_FAILED",
      evidenceHash: canonicalSha256("malformed"),
    } as any]),
  });
  const malformedClient = new FixtureMutationClient();
  await assert.rejects(
    malformed.coordinate(input(sideEffects(malformedClient))),
    (error: unknown) =>
      error instanceof V1EcsReleaseOutcomeError
      && error.code === "ECS_RELEASE_OUTCOME_CONTRACT_INVALID",
  );
  assert.equal(
    readFileSync(
      "src/orchestration-contracts/worker-runtime/"
        + "inactive-v1-ecs-release-outcome.coordinator.ts",
      "utf8",
    ).includes("registerTaskDefinitionRevision("),
    false,
  );
  console.log("Inactive v1 ECS release outcome unit checks passed.");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
