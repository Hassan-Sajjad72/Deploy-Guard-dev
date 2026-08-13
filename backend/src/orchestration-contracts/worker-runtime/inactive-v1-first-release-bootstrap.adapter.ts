import { canonicalSha256 } from "../contracts/canonical-json";
import { assertV1HandlerSideEffectTimeout } from "./v1-handler-side-effect.pure";
import {
  assertV1FirstReleaseEvidence,
  buildV1FirstReleaseServiceProbe,
  buildV1FirstReleaseMutationPlan,
  deriveV1FirstReleaseEffectKey,
  injectV1FirstReleaseImage,
} from "./inactive-v1-first-release-bootstrap.pure";
import {
  V1FirstReleaseBootstrapClient,
  V1FirstReleaseBootstrapError,
  V1FirstReleaseBootstrapInput,
  V1FirstReleaseBootstrapResult,
  V1FirstReleaseBootstrapStore,
  V1FirstReleaseFence,
} from "./inactive-v1-first-release-bootstrap.types";
import { V1HandlerSideEffectResult } from "./v1-handler-side-effect.types";

const TASK_ARN = /^arn:(?:aws|aws-us-gov|aws-cn):ecs:[a-z0-9-]+:[0-9]{12}:task-definition\/[A-Za-z0-9_.\/-]+:[1-9][0-9]*$/;
const SERVICE_ARN = /^arn:(?:aws|aws-us-gov|aws-cn):ecs:[a-z0-9-]+:[0-9]{12}:service\/[A-Za-z0-9_.\/-]+$/;

/** Explicitly constructed only in fixtures/future composition. It is not a Nest provider. */
export class InactiveV1FirstReleaseBootstrapAdapter {
  constructor(private readonly store: V1FirstReleaseBootstrapStore, private readonly client: V1FirstReleaseBootstrapClient) {}

  async bootstrap(input: V1FirstReleaseBootstrapInput): Promise<V1FirstReleaseBootstrapResult> {
    if (!input.sideEffects || !input.execution || this.client.policy !== "deployguard.first-release-bootstrap/client-v1") throw new V1FirstReleaseBootstrapError("FIRST_RELEASE_CONTRACT_INVALID");
    assertV1HandlerSideEffectTimeout(input.timeoutMs);
    this.assertTrusted(input);
    const infrastructure = await this.store.loadAppliedInfrastructure(input.identity);
    if (!infrastructure) throw new V1FirstReleaseBootstrapError("FIRST_RELEASE_INFRASTRUCTURE_NOT_APPLIED");
    const repositoryUrl = infrastructure.terraformOutputs.ecr_repository_url;
    if (typeof repositoryUrl !== "string") throw new V1FirstReleaseBootstrapError("FIRST_RELEASE_INFRASTRUCTURE_OUTPUT_INVALID");
    const existingRelease = await this.store.loadReleaseManifest(input.identity);
    if (!existingRelease?.initialServiceArn) {
      const probe = buildV1FirstReleaseServiceProbe(input.identity, infrastructure);
      const serviceEvidence = await this.client.inspectExactService(probe, this.contextFrom(input));
      if (serviceEvidence.state !== "absent") throw new V1FirstReleaseBootstrapError(serviceEvidence.state === "present" ? "FIRST_RELEASE_SERVICE_ALREADY_EXISTS" : "FIRST_RELEASE_SERVICE_ABSENCE_UNCERTAIN");
    }
    let pushed: { imageUri: string; imageDigest: string; commitSha: string; buildFingerprint: string } | null = null;
    const imageEffect = await input.sideEffects.execute({
      operationId: input.identity.buildPushOperationId,
      idempotencyKey: deriveV1FirstReleaseEffectKey(input.identity.idempotencyKey, "push_image", input.identity.buildPushOperationId),
      effectType: "ecr.build_push_immutable_image",
      inputFingerprint: canonicalSha256({ repositoryUrl, commitSha: input.releaseDraft.commitSha, buildFingerprint: input.releaseDraft.buildFingerprint }),
      timeoutMs: input.timeoutMs,
      perform: async (ownership) => {
        this.assertTrusted(input, ownership);
        const evidence = await this.client.buildAndPushImmutableImage({
          region: infrastructure.desiredSpec.region,
          repositoryUrl,
          commitSha: input.releaseDraft.commitSha,
          buildFingerprint: input.releaseDraft.buildFingerprint,
          projectId: input.identity.projectId,
          repositoryFullName: input.releaseDraft.repositoryFullName,
          branch: input.releaseDraft.branch,
          appRoot: input.releaseDraft.appRoot,
          dockerStrategy: input.releaseDraft.releaseSpec.build.dockerStrategy,
          deploymentContractHash: input.releaseDraft.deploymentContractHash,
        }, ownership);
        assertV1FirstReleaseEvidence(input.identity, infrastructure, evidence);
        pushed = evidence;
        return { outcome: "succeeded", safeResultCode: "ECR_IMMUTABLE_IMAGE_PUSHED", resultFingerprint: canonicalSha256(evidence), externalReferenceHash: canonicalSha256({ imageUri: evidence.imageUri, imageDigest: evidence.imageDigest }) };
      },
    });
    this.assertSucceeded(imageEffect);
    const buildRequest = {
      region: infrastructure.desiredSpec.region,
      repositoryUrl,
      commitSha: input.releaseDraft.commitSha,
      buildFingerprint: input.releaseDraft.buildFingerprint,
      projectId: input.identity.projectId,
      repositoryFullName: input.releaseDraft.repositoryFullName,
      branch: input.releaseDraft.branch,
      appRoot: input.releaseDraft.appRoot,
      dockerStrategy: input.releaseDraft.releaseSpec.build.dockerStrategy,
      deploymentContractHash: input.releaseDraft.deploymentContractHash,
    } as const;
    const image = pushed
      ?? await this.store.loadImageProvenance(input.identity)
      ?? await this.client.resolveImmutableImageEvidence(
        buildRequest,
        this.contextFrom(input),
      );
    if (!image) throw new V1FirstReleaseBootstrapError("FIRST_RELEASE_IMAGE_RECONCILIATION_REQUIRED");
    assertV1FirstReleaseEvidence(input.identity, infrastructure, image);
    // A succeeded effect can be replayed after a crash under a new, higher
    // operation lease. Its historical fence proves the effect record, while
    // the current execution fence authorizes the new provenance write.
    const fence = this.fence(input);
    await this.store.recordImageProvenance({ identity: input.identity, evidence: image, evidenceFingerprint: canonicalSha256(image), fence });
    // A normal first-release delivery may already own an image-less desired
    // candidate.  The store atomically hydrates that exact candidate after
    // provenance; it never creates a second manifest.
    let release = await this.store.createOrReuseReleaseManifest({ identity: input.identity, release: injectV1FirstReleaseImage(input.releaseDraft, image), evidence: image, fence });
    const plan = buildV1FirstReleaseMutationPlan({ identity: input.identity, infrastructure, release });
    let taskDefinitionArn: string | null = null;
    const taskDefinitionEffect = await input.sideEffects.execute({
      operationId: input.identity.registerTaskDefinitionOperationId,
      idempotencyKey: deriveV1FirstReleaseEffectKey(input.identity.idempotencyKey, "register_task", input.identity.registerTaskDefinitionOperationId), effectType: "ecs.register_initial_task_definition", inputFingerprint: plan.taskDefinitionInputHash, timeoutMs: input.timeoutMs,
      perform: async (ownership) => {
        this.assertTrusted(input, ownership);
        const result = await this.client.registerInitialTaskDefinition(plan.registerTaskDefinition, ownership);
        if (!result || Object.keys(result).length !== 1 || !TASK_ARN.test(result.taskDefinitionArn)) return { outcome: "failed", safeFailureCode: "ECS_INITIAL_TASK_RESULT_INVALID" };
        taskDefinitionArn = result.taskDefinitionArn;
        return { outcome: "succeeded", safeResultCode: "ECS_INITIAL_TASK_REGISTERED", resultFingerprint: canonicalSha256({ taskDefinitionArn, input: plan.taskDefinitionInputHash }), externalReferenceHash: canonicalSha256({ taskDefinitionArn }) };
      },
    });
    this.assertSucceeded(taskDefinitionEffect);
    if (taskDefinitionArn) release = await this.store.recordTaskDefinition({ releaseManifestId: release.id, taskDefinitionInputHash: plan.taskDefinitionInputHash, taskDefinitionArn, fence: this.fence(input) });
    const finalTaskArn = taskDefinitionArn ?? release.taskDefinitionArn;
    if (!finalTaskArn || !TASK_ARN.test(finalTaskArn)) throw new V1FirstReleaseBootstrapError("FIRST_RELEASE_TASK_RECONCILIATION_REQUIRED");
    let serviceArn: string | null = null;
    const serviceRequest = plan.createService(finalTaskArn);
    const serviceEffect = await input.sideEffects.execute({
      operationId: input.identity.createServiceOperationId,
      idempotencyKey: deriveV1FirstReleaseEffectKey(input.identity.idempotencyKey, "create_service", input.identity.createServiceOperationId), effectType: "ecs.create_initial_service", inputFingerprint: plan.serviceInputHash, timeoutMs: input.timeoutMs,
      perform: async (ownership) => {
        this.assertTrusted(input, ownership);
        const result = await this.client.createInitialService(serviceRequest, ownership);
        if (!result || Object.keys(result).length !== 1 || !SERVICE_ARN.test(result.serviceArn)) return { outcome: "failed", safeFailureCode: "ECS_INITIAL_SERVICE_RESULT_INVALID" };
        serviceArn = result.serviceArn;
        return { outcome: "succeeded", safeResultCode: "ECS_INITIAL_SERVICE_CREATED", resultFingerprint: canonicalSha256({ serviceArn, input: plan.serviceInputHash }), externalReferenceHash: canonicalSha256({ serviceArn }) };
      },
    });
    this.assertSucceeded(serviceEffect);
    if (serviceArn) release = await this.store.recordInitialService({ releaseManifestId: release.id, serviceInputHash: plan.serviceInputHash, serviceArn, fence: this.fence(input) });
    serviceArn = serviceArn ?? release.initialServiceArn;
    if (!serviceArn || !SERVICE_ARN.test(serviceArn)) throw new V1FirstReleaseBootstrapError("FIRST_RELEASE_SERVICE_RECONCILIATION_REQUIRED");
    this.assertTrusted(input);
    const healthEvidence = await this.client.verifyInitialRelease(
      plan.verifyHealth(finalTaskArn, serviceArn, input.timeoutMs),
      this.contextFrom(input),
    );
    this.assertTrusted(input);
    release = await this.store.recordHealthyRelease({
      releaseManifestId: release.id,
      evidence: healthEvidence,
      fence: this.fence(input),
    });
    return Object.freeze({
      disposition: "initial_release_healthy",
      releaseManifestId: release.id,
      releaseRevision: release.revision,
      taskDefinitionArn: finalTaskArn,
      serviceArn,
      applicationUrl: healthEvidence.applicationUrl,
      healthEvidenceHash: healthEvidence.evidenceHash,
      imageEffect,
      taskDefinitionEffect,
      serviceEffect,
    });
  }

  private assertTrusted(input: V1FirstReleaseBootstrapInput, ownership?: { signal: AbortSignal; isLeaseTrusted(): boolean }) {
    if (input.execution.signal.aborted || !input.execution.isLeaseTrusted() || ownership?.signal.aborted || (ownership && !ownership.isLeaseTrusted())) throw new V1FirstReleaseBootstrapError("FIRST_RELEASE_OWNERSHIP_LOST");
  }
  private assertSucceeded(result: V1HandlerSideEffectResult) {
    if ((result.disposition !== "executed" && result.disposition !== "replayed") || result.effect.status !== "succeeded") throw new V1FirstReleaseBootstrapError("FIRST_RELEASE_RECONCILIATION_REQUIRED");
  }
  private fence(input: V1FirstReleaseBootstrapInput): V1FirstReleaseFence {
    if (input.fence.intentId !== input.identity.intentId) {
      throw new V1FirstReleaseBootstrapError("FIRST_RELEASE_FENCE_MISMATCH");
    }
    return input.fence;
  }
  private contextFrom(input: V1FirstReleaseBootstrapInput) { return { signal: input.execution.signal, deadlineAt: new Date(Date.now() + input.timeoutMs), isLeaseTrusted: input.execution.isLeaseTrusted, intentId: input.identity.intentId, projectId: input.identity.projectId, environmentName: input.identity.environmentName, operationId: input.identity.createServiceOperationId, idempotencyKey: input.identity.idempotencyKey, effectType: "ecs.inspect_initial_service", inputFingerprint: input.identity.idempotencyKey, ...input.fence } as never; }
}
