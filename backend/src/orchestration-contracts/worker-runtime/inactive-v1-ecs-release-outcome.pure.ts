import { canonicalSha256 } from "../contracts/canonical-json";
import {
  V1EcsReleaseOutcomeError,
  V1EcsReleaseOutcomeFence,
  V1EcsReleaseOutcomeInput,
} from "./inactive-v1-ecs-release-outcome.types";
import {
  V1EcsReleaseRevisionIdentity,
} from "./inactive-v1-ecs-release-mutation.types";
import {
  V1EcsRolloutHealthVerificationResult,
} from "./inactive-v1-ecs-rollout-health.types";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;
const REVISION = /^(?:0|[1-9][0-9]*)$/;

export function assertV1EcsReleaseOutcomeInput(
  input: V1EcsReleaseOutcomeInput,
) {
  if (
    !input
    || !UUID.test(input.revision?.projectId)
    || !UUID.test(input.revision?.releaseManifestId)
    || !UUID.test(input.revision?.infrastructureManifestId)
    || !REVISION.test(input.revision?.releaseRevision)
    || !REVISION.test(input.revision?.infrastructureRevision)
    || typeof input.revision?.environmentName !== "string"
    || !/^[A-Za-z0-9_-]{1,64}$/.test(input.revision.environmentName)
    || !SHA256.test(input.idempotencyKey)
    || !UUID.test(input.rollbackOperationId)
    || !Number.isInteger(input.timeoutMs)
    || input.timeoutMs < 100
    || input.timeoutMs > 3_600_000
    || !(input.candidateDeadlineAt instanceof Date)
    || !Number.isFinite(input.candidateDeadlineAt.getTime())
    || !(input.rollbackDeadlineAt instanceof Date)
    || !Number.isFinite(input.rollbackDeadlineAt.getTime())
    || !input.execution?.signal
    || typeof input.execution.isLeaseTrusted !== "function"
    || typeof input.sideEffects?.execute !== "function"
    || typeof input.sideEffects?.finalizationStatus !== "function"
    || !validFence(input.fence)
  ) {
    throw new V1EcsReleaseOutcomeError(
      "ECS_RELEASE_OUTCOME_CONTRACT_INVALID",
    );
  }
}

export function assertV1EcsReleaseVerificationResult(
  result: V1EcsRolloutHealthVerificationResult,
) {
  const allowed = {
    healthy: ["ECS_ROLLOUT_AND_TARGETS_HEALTHY"],
    progressing: [
      "ECS_ROLLOUT_PROGRESSING",
      "ECS_TARGETS_REGISTERING",
    ],
    failed: [
      "ECS_ROLLOUT_FAILED",
      "ECS_TASK_START_FAILED",
      "ALB_TARGET_UNHEALTHY",
    ],
    timed_out: ["ECS_ROLLOUT_HEALTH_TIMEOUT"],
    ambiguous: ["ECS_ROLLOUT_EVIDENCE_AMBIGUOUS"],
  } as const;
  if (
    !result
    || !(result.status in allowed)
    || !(allowed[result.status] as readonly string[])
      .includes(result.safeCode)
    || !SHA256.test(result.evidenceHash)
    || Object.keys(result).some(
      (key) => !["status", "safeCode", "evidenceHash"].includes(key),
    )
  ) {
    throw new V1EcsReleaseOutcomeError(
      "ECS_RELEASE_OUTCOME_CONTRACT_INVALID",
    );
  }
}

export function assertV1EcsReleaseOutcomeTrusted(
  input: Pick<V1EcsReleaseOutcomeInput, "execution">,
) {
  if (
    input.execution.signal.aborted
    || !input.execution.isLeaseTrusted()
  ) {
    throw new V1EcsReleaseOutcomeError(
      "ECS_RELEASE_OUTCOME_OWNERSHIP_LOST",
    );
  }
}

export function candidateOutcomeFingerprint(
  revision: V1EcsReleaseRevisionIdentity,
  verification: V1EcsRolloutHealthVerificationResult,
) {
  return canonicalSha256({
    schemaVersion: 1,
    action: "candidate_outcome",
    revision,
    status: verification.status,
    safeCode: verification.safeCode,
    evidenceHash: verification.evidenceHash,
  });
}

export function rollbackMutationFingerprint(input: {
  revision: V1EcsReleaseRevisionIdentity;
  rollbackManifestId: string;
  rollbackRevision: string;
  previousStableManifestId: string;
  previousStableTaskDefinitionArn: string;
  clusterArn: string;
  serviceArn: string;
}) {
  return canonicalSha256({
    schemaVersion: 1,
    action: "rollback_existing_ecs_service",
    ...input,
  });
}

export function deriveRollbackIdempotencyKey(root: string) {
  return canonicalSha256({
    schemaVersion: 1,
    root,
    effect: "ecs.rollback_existing_service",
  });
}

function validFence(fence: V1EcsReleaseOutcomeFence) {
  return Boolean(
    fence
    && UUID.test(fence.intentId)
    && UUID.test(fence.leaseId)
    && /^[A-Za-z0-9._:@/-]{1,160}$/.test(fence.workerId)
    && /^(?:0|[1-9][0-9]*)$/.test(fence.fencingToken),
  );
}
