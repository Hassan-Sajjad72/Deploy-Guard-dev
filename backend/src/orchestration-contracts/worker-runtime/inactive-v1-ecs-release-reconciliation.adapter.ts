import { canonicalSha256 } from "../contracts/canonical-json";
import {
  buildV1EcsReleaseMutationPlan,
} from "./inactive-v1-ecs-release-mutation.pure";
import {
  V1EcsReleaseMutationError,
} from "./inactive-v1-ecs-release-mutation.types";
import {
  classifyV1EcsServiceUpdateEvidence,
  classifyV1EcsTaskDefinitionEvidence,
} from "./inactive-v1-ecs-release-reconciliation.pure";
import {
  V1EcsReleaseReadOnlyClient,
  V1EcsReleaseReconciliationAdapterInput,
  V1EcsReleaseReconciliationError,
  V1EcsServiceUpdateEvidenceQuery,
  V1EcsTaskDefinitionEvidenceQuery,
  V1PreparedEcsReleaseReconciliationAdapter,
} from "./inactive-v1-ecs-release-reconciliation.types";
import {
  v1HandlerSideEffectRequestFingerprint,
} from "./v1-handler-side-effect.pure";
import {
  V1ReadOnlySideEffectEvidence,
  V1ReadOnlySideEffectEvidenceAdapter,
  V1ReadOnlySideEffectInspectionContext,
} from "./v1-side-effect-reconciliation.types";

const HASH = /^[0-9a-f]{64}$/;
const IMAGE_DIGEST = /^sha256:[0-9a-f]{64}$/;
const TASK_DEFINITION_ARN =
  /^arn:(?:aws|aws-us-gov|aws-cn):ecs:[a-z0-9-]+:[0-9]{12}:task-definition\/[A-Za-z0-9_.\/-]+:[1-9][0-9]*$/;

type PreparedQuery =
  | {
      effectType: "ecs.register_task_definition_revision";
      inputFingerprint: string;
      query: V1EcsTaskDefinitionEvidenceQuery;
    }
  | {
      effectType: "ecs.update_existing_service";
      inputFingerprint: string;
      query: V1EcsServiceUpdateEvidenceQuery;
    };

function manualReview(
  code: string,
  identity: unknown,
): V1ReadOnlySideEffectEvidence {
  return {
    classification: "manual_review",
    safeFailureCode: code,
    evidenceFingerprint: canonicalSha256(identity),
  };
}

class PreparedInactiveV1EcsReleaseReconciliationAdapter
implements V1ReadOnlySideEffectEvidenceAdapter {
  readonly policy =
    "deployguard.side-effect-reconciliation/read-only-v1" as const;
  readonly adapterId: string;
  readonly effectType: string;

  constructor(
    private readonly prepared: PreparedQuery,
    private readonly client: V1EcsReleaseReadOnlyClient,
  ) {
    this.effectType = prepared.effectType;
    this.adapterId = prepared.effectType
      === "ecs.register_task_definition_revision"
      ? "deployguard.ecs-release.task-definition-read-v1"
      : "deployguard.ecs-release.service-update-read-v1";
  }

  async inspect(
    context: V1ReadOnlySideEffectInspectionContext,
  ): Promise<V1ReadOnlySideEffectEvidence> {
    this.assertTrusted(context);
    const mismatch = this.contextMismatch(context);
    if (mismatch) {
      return manualReview(
        "ECS_RECONCILIATION_SIDE_EFFECT_MISMATCH",
        mismatch,
      );
    }
    try {
      const evidence = this.prepared.effectType
        === "ecs.register_task_definition_revision"
        ? await this.client.findTaskDefinitionEvidence(
          this.prepared.query,
          context.signal,
        )
        : await this.client.findServiceUpdateEvidence(
          this.prepared.query,
          context.signal,
        );
      this.assertTrusted(context);
      return this.prepared.effectType
        === "ecs.register_task_definition_revision"
        ? classifyV1EcsTaskDefinitionEvidence(
          this.prepared.query,
          evidence,
        )
        : classifyV1EcsServiceUpdateEvidence(
          this.prepared.query,
          evidence,
        );
    } catch (error) {
      if (
        error instanceof V1EcsReleaseReconciliationError
        && error.code === "ECS_RELEASE_RECONCILIATION_OWNERSHIP_LOST"
      ) {
        throw error;
      }
      return manualReview("ECS_READ_ONLY_INSPECTION_FAILED", {
        schemaVersion: 1,
        effectType: this.effectType,
        query: this.prepared.query,
      });
    }
  }

  private contextMismatch(
    context: V1ReadOnlySideEffectInspectionContext,
  ) {
    const sideEffect = context.sideEffect;
    const expectedFingerprint = v1HandlerSideEffectRequestFingerprint({
      intentId: sideEffect.intentId,
      projectId: sideEffect.projectId,
      environmentName: sideEffect.environmentName,
      operationId: sideEffect.operationId,
      idempotencyKey: sideEffect.idempotencyKey,
      effectType: sideEffect.effectType,
      inputFingerprint: this.prepared.inputFingerprint,
      leaseId: sideEffect.leaseId,
      workerId: sideEffect.workerId,
      fencingToken: sideEffect.fencingToken,
    });
    if (
      context.readOnly !== true
      || sideEffect.intentId !== context.intentId
      || sideEffect.projectId !== context.projectId
      || sideEffect.environmentName !== context.environmentName
      || sideEffect.effectType !== this.prepared.effectType
      || sideEffect.requestFingerprint !== expectedFingerprint
      || context.projectId !== this.prepared.query.projectId
      || context.environmentName !== this.prepared.query.environmentName
    ) {
      return {
        schemaVersion: 1,
        sideEffectId: sideEffect.id,
        effectType: sideEffect.effectType,
        expectedEffectType: this.prepared.effectType,
        contextProjectId: context.projectId,
        expectedProjectId: this.prepared.query.projectId,
        contextEnvironmentName: context.environmentName,
        expectedEnvironmentName: this.prepared.query.environmentName,
      };
    }
    return null;
  }

  private assertTrusted(
    context: V1ReadOnlySideEffectInspectionContext,
  ) {
    if (
      context.signal.aborted
      || !context.isLeaseTrusted()
    ) {
      throw new V1EcsReleaseReconciliationError(
        "ECS_RELEASE_RECONCILIATION_OWNERSHIP_LOST",
      );
    }
  }
}

export async function prepareInactiveV1EcsReleaseReconciliationAdapter(
  input: V1EcsReleaseReconciliationAdapterInput,
): Promise<V1PreparedEcsReleaseReconciliationAdapter> {
  if (
    (
      input.client?.policy
        !== "deployguard.ecs-release-reconciliation/fixture-read-only-v1"
      && input.client?.policy
        !== "deployguard.ecs-release-reconciliation/disabled-aws-read-only-v1"
    )
    || !input.manifests
    || typeof input.manifests.loadExact !== "function"
    || (
      input.effect !== "register_task_definition"
      && input.effect !== "update_service"
    )
  ) {
    throw new V1EcsReleaseReconciliationError(
      "ECS_RELEASE_RECONCILIATION_CONTRACT_INVALID",
    );
  }
  const pair = await input.manifests.loadExact(input.revision);
  if (!pair) {
    throw new V1EcsReleaseReconciliationError(
      "ECS_RELEASE_RECONCILIATION_MANIFEST_NOT_FOUND",
    );
  }
  let plan;
  try {
    plan = buildV1EcsReleaseMutationPlan(input.revision, pair);
  } catch (error) {
    if (error instanceof V1EcsReleaseMutationError) {
      throw new V1EcsReleaseReconciliationError(
        "ECS_RELEASE_RECONCILIATION_CONTRACT_INVALID",
      );
    }
    throw error;
  }
  if (
    !pair.release.imageDigest
    || !IMAGE_DIGEST.test(pair.release.imageDigest)
    || (
      pair.release.taskDefinitionInputHash
      && pair.release.taskDefinitionInputHash !== plan.taskDefinitionInputHash
    )
  ) {
    throw new V1EcsReleaseReconciliationError(
      "ECS_RELEASE_RECONCILIATION_CONTRACT_INVALID",
    );
  }
  const taskQuery: V1EcsTaskDefinitionEvidenceQuery = Object.freeze({
    region: plan.registerTaskDefinition.region,
    family: plan.registerTaskDefinition.family,
    containerName: plan.registerTaskDefinition.containerName,
    projectId: input.revision.projectId,
    environmentName: input.revision.environmentName,
    releaseManifestId: input.revision.releaseManifestId,
    releaseRevision: input.revision.releaseRevision,
    infrastructureManifestId: input.revision.infrastructureManifestId,
    infrastructureRevision: input.revision.infrastructureRevision,
    taskDefinitionInputHash: plan.taskDefinitionInputHash,
    expectedTaskDefinitionArn: pair.release.taskDefinitionArn,
    immutableImage: plan.registerTaskDefinition.immutableImage,
    imageDigest: pair.release.imageDigest,
  });
  let prepared: PreparedQuery = {
    effectType: "ecs.register_task_definition_revision",
    inputFingerprint: plan.taskDefinitionInputHash,
    query: taskQuery,
  };
  if (input.effect === "update_service") {
    if (
      !pair.release.taskDefinitionArn
      || !TASK_DEFINITION_ARN.test(pair.release.taskDefinitionArn)
      || pair.release.taskDefinitionInputHash
        !== plan.taskDefinitionInputHash
    ) {
      throw new V1EcsReleaseReconciliationError(
        "ECS_RELEASE_RECONCILIATION_CONTRACT_INVALID",
      );
    }
    const inputFingerprint = canonicalSha256({
      schemaVersion: 1,
      serviceUpdateInputHash: plan.serviceUpdateInputHash,
      taskDefinitionArn: pair.release.taskDefinitionArn,
    });
    prepared = {
      effectType: "ecs.update_existing_service",
      inputFingerprint,
      query: Object.freeze({
        ...taskQuery,
        expectedTaskDefinitionArn: pair.release.taskDefinitionArn,
        clusterArn: plan.updateService.clusterArn,
        serviceArn: plan.updateService.serviceArn,
        taskDefinitionArn: pair.release.taskDefinitionArn,
        serviceUpdateInputHash: plan.serviceUpdateInputHash,
      }),
    };
  }
  if (
    !HASH.test(prepared.inputFingerprint)
    || !Object.isFrozen(prepared.query)
  ) {
    throw new V1EcsReleaseReconciliationError(
      "ECS_RELEASE_RECONCILIATION_CONTRACT_INVALID",
    );
  }
  const adapter =
    new PreparedInactiveV1EcsReleaseReconciliationAdapter(
      Object.freeze(prepared),
      input.client,
    );
  return Object.freeze({
    adapter,
    inspectionFingerprint: canonicalSha256({
      schemaVersion: 1,
      adapterId: adapter.adapterId,
      effectType: adapter.effectType,
      inputFingerprint: prepared.inputFingerprint,
      query: prepared.query,
    }),
  });
}
