import { canonicalSha256 } from "../contracts/canonical-json";
import {
  assertV1EcsReleaseOutcomeInput,
  assertV1EcsReleaseOutcomeTrusted,
  assertV1EcsReleaseVerificationResult,
  candidateOutcomeFingerprint,
  deriveRollbackIdempotencyKey,
  rollbackMutationFingerprint,
} from "./inactive-v1-ecs-release-outcome.pure";
import {
  V1EcsReleaseOutcomeDependencies,
  V1EcsReleaseOutcomeError,
  V1EcsReleaseOutcomeInput,
  V1EcsReleaseOutcomeResult,
} from "./inactive-v1-ecs-release-outcome.types";
import {
  V1HandlerSideEffectExecutorContext,
  V1HandlerSideEffectResult,
} from "./v1-handler-side-effect.types";

const SERVICE_ARN =
  /^arn:(?:aws|aws-us-gov|aws-cn):ecs:[a-z0-9-]+:[0-9]{12}:service\/[A-Za-z0-9_.\/-]+$/;

export class InactiveV1EcsReleaseOutcomeCoordinator {
  constructor(private readonly dependencies: V1EcsReleaseOutcomeDependencies) {
    if (
      !dependencies?.manifests
      || typeof dependencies.manifests.loadExact !== "function"
      || !dependencies.outcomes
      || typeof dependencies.outcomes.promoteCandidate !== "function"
      || typeof dependencies.outcomes.prepareRollback !== "function"
      || typeof dependencies.outcomes.finalizeRollback !== "function"
      || dependencies.mutationClient?.policy
        !== "deployguard.ecs-release-mutation/client-v1"
      || dependencies.verifier?.policy
        !== "deployguard.ecs-rollout-health/disabled-read-only-v1"
    ) {
      throw new V1EcsReleaseOutcomeError(
        "ECS_RELEASE_OUTCOME_CONTRACT_INVALID",
      );
    }
  }

  async coordinate(
    input: V1EcsReleaseOutcomeInput,
  ): Promise<V1EcsReleaseOutcomeResult> {
    assertV1EcsReleaseOutcomeInput(input);
    this.assertTrusted(input);
    const candidateVerification = await this.dependencies.verifier.verify({
      revision: input.revision,
      manifests: this.dependencies.manifests,
      execution: input.execution,
      deadlineAt: input.candidateDeadlineAt,
    });
    assertV1EcsReleaseVerificationResult(candidateVerification);
    this.assertTrusted(input);
    const inputFingerprint = candidateOutcomeFingerprint(
      input.revision,
      candidateVerification,
    );

    if (candidateVerification.status === "progressing") {
      return {
        disposition: "candidate_progressing",
        verification: candidateVerification,
      };
    }
    if (candidateVerification.status === "ambiguous") {
      return {
        disposition: "manual_review_required",
        verification: candidateVerification,
      };
    }
    if (candidateVerification.status === "healthy") {
      this.assertFinalizationAllowed(input);
      const result = await this.dependencies.outcomes.promoteCandidate({
        revision: input.revision,
        idempotencyKey: input.idempotencyKey,
        inputFingerprint,
        verification: candidateVerification,
        fence: input.fence,
      });
      return {
        disposition: "candidate_promoted",
        verification: candidateVerification,
        replayed: result.disposition === "replayed",
      };
    }

    const preparation = await this.dependencies.outcomes.prepareRollback({
      revision: input.revision,
      idempotencyKey: input.idempotencyKey,
      inputFingerprint,
      candidateVerification,
      fence: input.fence,
    });
    if (preparation.disposition === "rollback_target_missing") {
      return {
        disposition: "rollback_target_missing",
        verification: candidateVerification,
        safeCode: preparation.safeCode,
      };
    }
    const target = preparation.target;
    const mutationFingerprint = rollbackMutationFingerprint({
      revision: input.revision,
      rollbackManifestId: target.rollbackManifestId,
      rollbackRevision: target.rollbackRevision,
      previousStableManifestId:
        target.previousStable.releaseManifestId,
      previousStableTaskDefinitionArn:
        target.previousStable.taskDefinitionArn,
      clusterArn: target.clusterArn,
      serviceArn: target.serviceArn,
    });
    const effect = await input.sideEffects.execute({
      operationId: input.rollbackOperationId,
      idempotencyKey: deriveRollbackIdempotencyKey(input.idempotencyKey),
      effectType: "ecs.rollback_existing_service",
      inputFingerprint: mutationFingerprint,
      timeoutMs: input.timeoutMs,
      perform: async (ownership) => {
        this.assertTrusted(input, ownership);
        const result =
          await this.dependencies.mutationClient.updateExistingService({
            region: this.awsRegion(target.clusterArn),
            clusterArn: target.clusterArn,
            serviceArn: target.serviceArn,
            taskDefinitionArn:
              target.previousStable.taskDefinitionArn,
            forceNewDeployment: true,
          }, ownership);
        this.assertTrusted(input, ownership);
        if (
          !result
          || Object.keys(result).length !== 1
          || result.serviceArn !== target.serviceArn
          || !SERVICE_ARN.test(result.serviceArn)
        ) {
          return {
            outcome: "failed",
            safeFailureCode: "ECS_ROLLBACK_SERVICE_RESULT_INVALID",
          };
        }
        return {
          outcome: "succeeded",
          safeResultCode: "ECS_ROLLBACK_SERVICE_UPDATE_REQUESTED",
          resultFingerprint: canonicalSha256({
            schemaVersion: 1,
            mutationFingerprint,
            serviceArn: result.serviceArn,
          }),
          externalReferenceHash: canonicalSha256({
            serviceArn: result.serviceArn,
          }),
        };
      },
    });
    this.assertEffectFence(input, effect);
    if (effect.disposition === "reconciliation_required") {
      return {
        disposition: "rollback_reconciliation_required",
        safeCode: effect.reason,
      };
    }
    if (effect.disposition === "failed") {
      return {
        disposition: "rollback_failed",
        safeCode: effect.effect.failureCode
          ?? "ECS_ROLLBACK_SERVICE_UPDATE_FAILED",
      };
    }
    if (effect.disposition === "in_progress") {
      return {
        disposition: "rollback_reconciliation_required",
        safeCode: "ECS_ROLLBACK_SIDE_EFFECT_IN_PROGRESS",
      };
    }

    this.assertTrusted(input);
    const rollbackVerification = await this.dependencies.verifier.verify({
      revision: target.previousStable,
      manifests: this.dependencies.manifests,
      execution: input.execution,
      deadlineAt: input.rollbackDeadlineAt,
    });
    assertV1EcsReleaseVerificationResult(rollbackVerification);
    this.assertTrusted(input);
    if (rollbackVerification.status === "progressing") {
      return {
        disposition: "rollback_verification_pending",
        verification: rollbackVerification,
      };
    }
    if (rollbackVerification.status !== "healthy") {
      if (rollbackVerification.status === "failed") {
        return {
          disposition: "rollback_failed",
          safeCode: rollbackVerification.safeCode,
        };
      }
      return {
        disposition: "manual_review_required",
        verification: rollbackVerification,
      };
    }
    this.assertFinalizationAllowed(input);
    const finalized = await this.dependencies.outcomes.finalizeRollback({
      revision: input.revision,
      rollbackManifestId: target.rollbackManifestId,
      rollbackRevision: target.rollbackRevision,
      previousStableManifestId:
        target.previousStable.releaseManifestId,
      idempotencyKey: input.idempotencyKey,
      inputFingerprint,
      verification: rollbackVerification,
      fence: input.fence,
    });
    return {
      disposition: "rollback_completed",
      verification: rollbackVerification,
      replayed: finalized.disposition === "replayed",
    };
  }

  private assertTrusted(
    input: V1EcsReleaseOutcomeInput,
    ownership?: V1HandlerSideEffectExecutorContext,
  ) {
    assertV1EcsReleaseOutcomeTrusted(input);
    if (
      ownership
      && (
        ownership.signal.aborted
        || !ownership.isLeaseTrusted()
        || ownership.intentId !== input.fence.intentId
        || ownership.leaseId !== input.fence.leaseId
        || ownership.workerId !== input.fence.workerId
        || ownership.fencingToken !== input.fence.fencingToken
        || ownership.projectId !== input.revision.projectId
        || ownership.environmentName
          !== input.revision.environmentName
      )
    ) {
      throw new V1EcsReleaseOutcomeError(
        "ECS_RELEASE_OUTCOME_OWNERSHIP_LOST",
      );
    }
  }

  private assertFinalizationAllowed(input: V1EcsReleaseOutcomeInput) {
    this.assertTrusted(input);
    const finalization = input.sideEffects.finalizationStatus();
    if (!finalization.allowed) {
      throw new V1EcsReleaseOutcomeError(
        "ECS_RELEASE_OUTCOME_OWNERSHIP_LOST",
      );
    }
  }

  private assertEffectFence(
    input: V1EcsReleaseOutcomeInput,
    result: V1HandlerSideEffectResult,
  ) {
    const effect = result.effect;
    if (
      effect.intentId !== input.fence.intentId
      || effect.projectId !== input.revision.projectId
      || effect.environmentName !== input.revision.environmentName
      || effect.leaseId !== input.fence.leaseId
      || effect.workerId !== input.fence.workerId
      || effect.fencingToken !== input.fence.fencingToken
    ) {
      throw new V1EcsReleaseOutcomeError(
        "ECS_RELEASE_OUTCOME_OWNERSHIP_LOST",
      );
    }
  }

  private awsRegion(arn: string) {
    const region = arn.split(":")[3];
    if (!/^[a-z]{2}(?:-gov)?-[a-z]+-[1-9][0-9]*$/.test(region)) {
      throw new V1EcsReleaseOutcomeError(
        "ECS_RELEASE_OUTCOME_CONTRACT_INVALID",
      );
    }
    return region;
  }
}
