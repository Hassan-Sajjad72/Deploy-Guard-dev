import { canonicalSha256 } from "../contracts/canonical-json";
import {
  assertV1EcsReleaseMutationIdentity,
  buildV1EcsReleaseMutationPlan,
  deriveV1EcsReleaseEffectIdempotencyKey,
} from "./inactive-v1-ecs-release-mutation.pure";
import {
  V1EcsReleaseManifestStore,
  V1EcsReleaseMutationClient,
  V1EcsReleaseMutationError,
  V1EcsReleaseMutationInput,
  V1EcsReleaseMutationResult,
} from "./inactive-v1-ecs-release-mutation.types";
import {
  V1HandlerSideEffectExecutorContext,
  V1HandlerSideEffectResult,
} from "./v1-handler-side-effect.types";

const TASK_DEFINITION_ARN =
  /^arn:(?:aws|aws-us-gov|aws-cn):ecs:[a-z0-9-]+:[0-9]{12}:task-definition\/[A-Za-z0-9_.\/-]+:[1-9][0-9]*$/;
const SERVICE_ARN =
  /^arn:(?:aws|aws-us-gov|aws-cn):ecs:[a-z0-9-]+:[0-9]{12}:service\/[A-Za-z0-9_.\/-]+$/;

export class InactiveV1EcsReleaseMutationAdapter {
  constructor(
    private readonly manifests: V1EcsReleaseManifestStore,
    private readonly client: V1EcsReleaseMutationClient,
  ) {}

  async mutate(
    input: V1EcsReleaseMutationInput,
  ): Promise<V1EcsReleaseMutationResult> {
    assertV1EcsReleaseMutationIdentity(
      input.revision,
      input.mutation,
      input.timeoutMs,
    );
    if (
      !input.sideEffects
      || typeof input.sideEffects.execute !== "function"
      || !input.execution
      || typeof input.execution.isLeaseTrusted !== "function"
      || !input.execution.signal
      || !input.fence
      || typeof input.fence.intentId !== "string"
      || typeof input.fence.leaseId !== "string"
      || typeof input.fence.workerId !== "string"
      || typeof input.fence.fencingToken !== "string"
      || this.client.policy
        !== "deployguard.ecs-release-mutation/client-v1"
    ) {
      throw new V1EcsReleaseMutationError("ECS_RELEASE_CONTRACT_INVALID");
    }
    this.assertTrusted(input);

    const pair = await this.manifests.loadExact(input.revision);
    if (!pair) {
      throw new V1EcsReleaseMutationError(
        "ECS_RELEASE_MANIFEST_NOT_FOUND",
      );
    }
    const plan = buildV1EcsReleaseMutationPlan(input.revision, pair);
    if (
      pair.release.taskDefinitionInputHash
      && pair.release.taskDefinitionInputHash !== plan.taskDefinitionInputHash
    ) {
      throw new V1EcsReleaseMutationError(
        "ECS_RELEASE_TASK_REFERENCE_CONFLICT",
      );
    }

    let registeredTaskDefinitionArn: string | null = null;
    const registerTaskDefinitionEffect = await input.sideEffects.execute({
      operationId: input.mutation.registerTaskDefinitionOperationId,
      idempotencyKey: deriveV1EcsReleaseEffectIdempotencyKey(
        input.mutation.idempotencyKey,
        "register_task_definition",
      ),
      effectType: "ecs.register_task_definition_revision",
      inputFingerprint: plan.taskDefinitionInputHash,
      timeoutMs: input.timeoutMs,
      perform: async (ownership) => {
        this.assertTrusted(input, ownership);
        const result = await this.client.registerTaskDefinitionRevision(
          plan.registerTaskDefinition,
          ownership,
        );
        this.assertTrusted(input, ownership);
        if (
          !result
          || Object.keys(result).length !== 1
          || typeof result.taskDefinitionArn !== "string"
          || !TASK_DEFINITION_ARN.test(result.taskDefinitionArn)
        ) {
          return {
            outcome: "failed",
            safeFailureCode: "ECS_TASK_DEFINITION_RESULT_INVALID",
          };
        }
        registeredTaskDefinitionArn = result.taskDefinitionArn;
        return {
          outcome: "succeeded",
          safeResultCode: "ECS_TASK_DEFINITION_REGISTERED",
          resultFingerprint: canonicalSha256({
            schemaVersion: 1,
            taskDefinitionInputHash: plan.taskDefinitionInputHash,
            taskDefinitionArn: result.taskDefinitionArn,
          }),
          externalReferenceHash: canonicalSha256({
            taskDefinitionArn: result.taskDefinitionArn,
          }),
        };
      },
    });
    this.assertSuccessfulEffect(registerTaskDefinitionEffect);
    this.assertTrusted(input);

    let taskDefinitionArn = registeredTaskDefinitionArn
      ?? (
        pair.release.taskDefinitionInputHash === plan.taskDefinitionInputHash
          ? pair.release.taskDefinitionArn
          : null
      );
    if (!taskDefinitionArn || !TASK_DEFINITION_ARN.test(taskDefinitionArn)) {
      throw new V1EcsReleaseMutationError(
        "ECS_RELEASE_TASK_REFERENCE_CONFLICT",
      );
    }
    const recorded = await this.manifests.recordTaskDefinitionReference({
      identity: input.revision,
      taskDefinitionInputHash: plan.taskDefinitionInputHash,
      taskDefinitionArn,
      fence: input.fence,
    });
    if (
      recorded.taskDefinitionInputHash !== plan.taskDefinitionInputHash
      || recorded.taskDefinitionArn !== taskDefinitionArn
    ) {
      throw new V1EcsReleaseMutationError(
        "ECS_RELEASE_TASK_REFERENCE_CONFLICT",
      );
    }
    taskDefinitionArn = recorded.taskDefinitionArn;
    this.assertTrusted(input);

    let updatedServiceArn: string | null = null;
    const updateRequest = {
      ...plan.updateService,
      taskDefinitionArn,
    };
    const updateInputFingerprint = canonicalSha256({
      schemaVersion: 1,
      serviceUpdateInputHash: plan.serviceUpdateInputHash,
      taskDefinitionArn,
    });
    const updateServiceEffect = await input.sideEffects.execute({
      operationId: input.mutation.updateServiceOperationId,
      idempotencyKey: deriveV1EcsReleaseEffectIdempotencyKey(
        input.mutation.idempotencyKey,
        "update_service",
      ),
      effectType: "ecs.update_existing_service",
      inputFingerprint: updateInputFingerprint,
      timeoutMs: input.timeoutMs,
      perform: async (ownership) => {
        this.assertTrusted(input, ownership);
        const result = await this.client.updateExistingService(
          updateRequest,
          ownership,
        );
        this.assertTrusted(input, ownership);
        if (
          !result
          || Object.keys(result).length !== 1
          || typeof result.serviceArn !== "string"
          || !SERVICE_ARN.test(result.serviceArn)
          || result.serviceArn !== updateRequest.serviceArn
        ) {
          return {
            outcome: "failed",
            safeFailureCode: "ECS_SERVICE_UPDATE_RESULT_INVALID",
          };
        }
        updatedServiceArn = result.serviceArn;
        return {
          outcome: "succeeded",
          safeResultCode: "ECS_SERVICE_UPDATE_REQUESTED",
          resultFingerprint: canonicalSha256({
            schemaVersion: 1,
            updateInputFingerprint,
            serviceArn: result.serviceArn,
          }),
          externalReferenceHash: canonicalSha256({
            serviceArn: result.serviceArn,
          }),
        };
      },
    });
    this.assertSuccessfulEffect(updateServiceEffect);
    const serviceArn = updatedServiceArn ?? updateRequest.serviceArn;

    return Object.freeze({
      disposition: "service_update_recorded",
      releaseManifestId: plan.releaseManifestId,
      releaseRevision: plan.releaseRevision,
      infrastructureManifestId: plan.infrastructureManifestId,
      infrastructureRevision: plan.infrastructureRevision,
      taskDefinitionArn,
      serviceArn,
      registerTaskDefinitionEffect,
      updateServiceEffect,
    });
  }

  private assertTrusted(
    input: V1EcsReleaseMutationInput,
    ownership?: V1HandlerSideEffectExecutorContext,
  ) {
    if (
      input.execution.signal.aborted
      || !input.execution.isLeaseTrusted()
      || ownership?.signal.aborted
      || (ownership && !ownership.isLeaseTrusted())
    ) {
      throw new V1EcsReleaseMutationError("ECS_RELEASE_OWNERSHIP_LOST");
    }
  }

  private assertSuccessfulEffect(result: V1HandlerSideEffectResult) {
    if (
      result.disposition !== "executed"
      && result.disposition !== "replayed"
    ) {
      throw new V1EcsReleaseMutationError("ECS_RELEASE_MUTATION_BLOCKED");
    }
    if (result.effect.status !== "succeeded") {
      throw new V1EcsReleaseMutationError("ECS_RELEASE_MUTATION_BLOCKED");
    }
  }
}
