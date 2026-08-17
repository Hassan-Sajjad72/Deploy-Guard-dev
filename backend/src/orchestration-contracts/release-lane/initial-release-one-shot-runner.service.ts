import { createHash } from "node:crypto";
import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { DataSource } from "typeorm";
import { DescribeImagesCommand, ECRClient } from "@aws-sdk/client-ecr";
import { canonicalSha256 } from "../contracts/canonical-json";
import { workerEnvelopePayloadForHash } from "../contracts/worker-envelope.validator";
import { InitialReleaseDraft } from "../entities/initial-release-draft.entity";
import { CrossLaneOwnershipEnforcementService } from "./cross-lane-ownership-enforcement.service";
import { ProductionV1FirstReleaseIdentityPreflightService } from "./production-v1-first-release-identity-preflight.service";
import { InactiveV1ReleaseLaneCompositionService } from "./inactive-v1-release-lane-composition";
import { InactiveV1PreExecutionOwnershipService } from "../worker-runtime/inactive-v1-pre-execution-ownership.service";
import { InactiveV1ExecutionLeaseHeartbeatService } from "../worker-runtime/inactive-v1-execution-lease-heartbeat.service";
import { InactiveV1HandlerSideEffectSafetyService } from "../worker-runtime/inactive-v1-handler-side-effect-safety.service";
import { V1WorkerCapabilityService } from "../worker-runtime/v1-worker-capability.service";

/** Explicitly callable only. No controller, scheduler, queue, or lifecycle hook uses it. */
@Injectable()
export class InitialReleaseOneShotRunnerService {
  constructor(
    private readonly config: ConfigService,
    private readonly dataSource: DataSource,
    private readonly preflight: ProductionV1FirstReleaseIdentityPreflightService,
    private readonly composition: InactiveV1ReleaseLaneCompositionService,
    private readonly crossLane: CrossLaneOwnershipEnforcementService,
    private readonly capabilities: V1WorkerCapabilityService,
    private readonly ownership: InactiveV1PreExecutionOwnershipService,
    private readonly heartbeat: InactiveV1ExecutionLeaseHeartbeatService,
    private readonly sideEffects: InactiveV1HandlerSideEffectSafetyService,
  ) {}

  async readiness(intentId: string) {
    if (this.config.get<unknown>("TWO_LANE_FIRST_RELEASE_ONE_SHOT_ENABLED") !== "true"
      || this.config.get<unknown>("TWO_LANE_FIRST_RELEASE_LIVE_CLIENT_ENABLED") !== "true") {
      return { state: "blocked" as const, safeCodes: ["FIRST_RELEASE_ONE_SHOT_DISABLED"] };
    }
    const composition = this.composition.getInactiveComposition();
    if (!composition?.firstReleaseBootstrap) {
      return { state: "blocked" as const, safeCodes: ["FIRST_RELEASE_COMPOSITION_NOT_READY"] };
    }
    const draft = await this.dataSource.getRepository(InitialReleaseDraft).findOne({ where: { intentId } });
    if (!draft || canonicalSha256(draft.releaseDraft) !== draft.draftHash) {
      return { state: "blocked" as const, safeCodes: ["INITIAL_RELEASE_DRAFT_INVALID"] };
    }
    const rows = await this.dataSource.query(
      `SELECT intent.status,
              intent.release_manifest_id AS "releaseManifestId",
              release.task_definition_arn AS "taskDefinitionArn",
              release.initial_service_arn AS "initialServiceArn"
       FROM deployment_intents intent
       LEFT JOIN release_manifests release
         ON release.id = intent.release_manifest_id
        AND release.project_id = intent.project_id
        AND release.environment_name = intent.environment_name
        AND release.infrastructure_manifest_id = intent.infrastructure_manifest_id
       WHERE intent.id = $1 AND intent.project_id = $2 AND intent.environment_name = 'dev'
         AND intent.infrastructure_manifest_id = $3
         AND intent.classification = 'release_only'
         AND (
           (intent.status IN ('planned','enqueued') AND intent.release_manifest_id IS NULL)
           OR
           (intent.status = 'running' AND intent.release_manifest_id IS NULL
             AND NOT EXISTS (SELECT 1 FROM deployment_side_effects effect
               WHERE effect.intent_id = intent.id
                 AND effect.status IN ('prepared','started','uncertain'))
             AND NOT EXISTS (
               SELECT 1 FROM release_image_provenances provenance
               WHERE provenance.intent_id = intent.id
             ))
           OR
           (intent.status = 'running' AND intent.release_manifest_id IS NOT NULL
             AND release.task_definition_arn IS NOT NULL
             AND release.initial_service_arn IS NOT NULL)
         )`,
      [intentId, draft.projectId, draft.infrastructureManifestId],
    );
    if (rows.length !== 1) {
      return { state: "blocked" as const, safeCodes: ["INITIAL_RELEASE_INTENT_NOT_CLAIMABLE"] };
    }
    if (rows[0].releaseManifestId) {
      return { state: "ready" as const, safeCodes: ["FIRST_RELEASE_RECONCILIATION_READY"] };
    }
    const readiness = await this.preflight.run();
    if (readiness.state !== "ready" || !readiness.safeCodes.includes("FIRST_RELEASE_IDENTITY_READY")) {
      return { state: "blocked" as const, safeCodes: [...readiness.safeCodes] };
    }
    return { state: "ready" as const, safeCodes: ["FIRST_RELEASE_ONE_SHOT_READY"] };
  }

  async run(intentId: string) {
    const readiness = await this.readiness(intentId);
    if (readiness.state !== "ready") throw new Error(readiness.safeCodes[0] || "FIRST_RELEASE_IDENTITY_NOT_READY");
    const draft = await this.dataSource.getRepository(InitialReleaseDraft).findOne({ where: { intentId } });
    if (!draft || canonicalSha256(draft.releaseDraft) !== draft.draftHash) throw new Error("INITIAL_RELEASE_DRAFT_INVALID");
    const rows = await this.dataSource.query(`SELECT id, canonical_idempotency_key AS "canonicalKey", request_fingerprint AS "requestFingerprint", status FROM deployment_intents WHERE id = $1 AND project_id = $2 AND environment_name = 'dev' AND infrastructure_manifest_id = $3 AND classification = 'release_only'`, [intentId, draft.projectId, draft.infrastructureManifestId]);
    const intent = rows[0];
    if (!intent || !["planned", "enqueued", "running"].includes(intent.status)) throw new Error("INITIAL_RELEASE_INTENT_NOT_CLAIMABLE");
    const workerId = this.config.get<string>("TWO_LANE_RELEASE_WORKER_ID", "");
    if (!workerId) throw new Error("INITIAL_RELEASE_WORKER_INVALID");
    const claim = await this.crossLane.acquireV1({ projectId: draft.projectId, environmentName: "dev", intentId, actorId: workerId, requestFingerprint: intent.requestFingerprint });
    if (!claim.enabled) throw new Error("INITIAL_RELEASE_OWNERSHIP_DISABLED");
    let operation: Awaited<ReturnType<InactiveV1PreExecutionOwnershipService["claim"]>> | null = null;
    let crossLaneHeartbeat: ReturnType<CrossLaneOwnershipEnforcementService["startHeartbeat"]> | null = null;
    let capabilityHeartbeat: Awaited<ReturnType<V1WorkerCapabilityService["startHeartbeatSession"]>> | null = null;
    try {
      await this.dataSource.query(`UPDATE deployment_intents SET status = 'enqueued', enqueued_at = COALESCE(enqueued_at, clock_timestamp()), updated_at = clock_timestamp() WHERE id = $1 AND status = 'planned'`, [intentId]);
      const envelope: any = { protocol: { name: "deployguard.worker", schemaVersion: 1, messageType: "intent.release.execute", minimumWorkerProtocol: 1, maximumWorkerProtocol: 1 }, producer: { service: "deployguard-api", serviceVersion: "one-shot", gitSha: "local", producedAt: new Date().toISOString() }, identity: { intentId, projectId: draft.projectId, environmentName: "dev", pipelineRunId: null, destroyOperationId: null, infrastructureManifestId: draft.infrastructureManifestId, releaseManifestId: null }, routing: { lane: "release", operation: "execute", queue: "deployguard-release-v1" }, idempotency: { canonicalKey: intent.canonicalKey, payloadSha256: "0".repeat(64), attempt: 1, replayOfJobId: null }, execution: { mode: "full", resumeFromStage: null, reusableCheckpointIds: [], invalidatedCheckpointIds: [], reasonCodes: ["INITIAL_RELEASE_ONE_SHOT"], fencingTokenRequired: true }, trace: { correlationId: intentId, causationId: null, actorUserId: null }, expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString() };
      envelope.idempotency.payloadSha256 = canonicalSha256(workerEnvelopePayloadForHash(envelope));
      capabilityHeartbeat = await this.capabilities.startHeartbeatSession({ workerId, role: "release", supportedMessageTypes: ["intent.release.execute"], serviceVersion: "one-shot", gitSha: "local", heartbeatTtlMs: 60_000, metadata: {} });
      operation = await this.ownership.claim({ workerId, queueName: envelope.routing.queue, envelope });
      if (operation.disposition !== "claimed" && operation.disposition !== "already_owned") throw new Error("INITIAL_RELEASE_CLAIM_NOT_ACQUIRED");
      await this.crossLane.attachV1OperationLease(claim, { intentId, operationLeaseId: operation.lease.leaseId, operationWorkerId: workerId, operationFencingToken: operation.lease.fencingToken });
      if (!(await this.crossLane.validateV1Fences(claim, { intentId, operationLeaseId: operation.lease.leaseId, operationWorkerId: workerId, operationFencingToken: operation.lease.fencingToken }))) {
        throw new Error("INITIAL_RELEASE_CROSS_LANE_OWNERSHIP_LOST");
      }
      crossLaneHeartbeat = this.crossLane.startHeartbeat(claim, { leaseTtlMs: 60_000 });
      const session = this.heartbeat.start({ leaseId: operation.lease.leaseId, workerId, fencingToken: operation.lease.fencingToken, leaseTtlMs: 60_000 });
      try {
        const composed = this.composition.getInactiveComposition();
        if (!composed?.firstReleaseBootstrap) throw new Error("FIRST_RELEASE_BOOTSTRAP_NOT_COMPOSED");
        const key = intent.canonicalKey;
        const failedPushes = await this.dataSource.query(
          `SELECT count(*)::int AS count FROM deployment_side_effects
           WHERE intent_id = $1 AND effect_type = 'ecr.build_push_immutable_image'
             AND status = 'failed'`,
          [intentId],
        );
        const pushAttempt = Number(failedPushes[0]?.count ?? 0);
        const id = (suffix: string) => this.deterministicId(intentId, suffix);
        const trusted = () => session.isTrusted() && crossLaneHeartbeat!.isTrusted();
        const result = await composed.runFirstReleaseBootstrap({ identity: { projectId: draft.projectId, environmentName: "dev", infrastructureManifestId: draft.infrastructureManifestId, infrastructureRevision: draft.infrastructureRevision, intentId, idempotencyKey: key, buildPushOperationId: id(pushAttempt === 0 ? "push" : `push-retry-${pushAttempt}`), registerTaskDefinitionOperationId: id("task"), createServiceOperationId: id("service") }, releaseDraft: draft.releaseDraft, timeoutMs: 900_000, execution: { signal: session.signal, isLeaseTrusted: trusted }, fence: { intentId, leaseId: operation.lease.leaseId, workerId, fencingToken: operation.lease.fencingToken }, sideEffects: this.sideEffects.forExecution({ intentId, projectId: draft.projectId, environmentName: "dev", leaseId: operation.lease.leaseId, workerId, fencingToken: operation.lease.fencingToken, signal: session.signal, isLeaseTrusted: trusted }) });
        await this.ownership.complete({ leaseId: operation.lease.leaseId, workerId, fencingToken: operation.lease.fencingToken });
        await this.crossLane.releaseV1(claim, { intentId, operationLeaseId: operation.lease.leaseId });
        return result;
      } finally { await session.stop(); }
    } catch (error) {
      // Once an operation lease exists, a failure can represent an uncertain
      // external side effect. Keep both independent ownership records for the
      // reconciliation path rather than releasing them on a guessed outcome.
      if (!operation) await this.crossLane.release(claim).catch(() => undefined);
      throw error;
    } finally {
      await crossLaneHeartbeat?.stop();
      await capabilityHeartbeat?.stop();
    }
  }

  async reconcileImageAbsence(intentId: string) {
    if (this.config.get<unknown>("TWO_LANE_FIRST_RELEASE_ONE_SHOT_ENABLED") !== "true"
      || this.config.get<unknown>("TWO_LANE_FIRST_RELEASE_LIVE_CLIENT_ENABLED") !== "true") {
      return { state: "blocked" as const, safeCodes: ["FIRST_RELEASE_ONE_SHOT_DISABLED"] };
    }
    const draft = await this.dataSource.getRepository(InitialReleaseDraft).findOne({ where: { intentId } });
    if (!draft || canonicalSha256(draft.releaseDraft) !== draft.draftHash) {
      return { state: "blocked" as const, safeCodes: ["INITIAL_RELEASE_DRAFT_INVALID"] };
    }
    const rows = await this.dataSource.query(
      `SELECT effect.id, effect.operation_id AS "operationId",
              effect.idempotency_key AS "idempotencyKey",
              infrastructure.terraform_outputs->>'ecr_repository_name' AS "repositoryName",
              infrastructure.terraform_outputs->>'ecr_repository_url' AS "repositoryUrl",
              (SELECT count(*)::int FROM deployment_side_effect_reconciliations reconciliation
               WHERE reconciliation.side_effect_id = effect.id) AS "reconciliationCount"
       FROM deployment_side_effects effect
       INNER JOIN deployment_intents intent ON intent.id = effect.intent_id
       INNER JOIN infrastructure_manifests infrastructure
         ON infrastructure.id = intent.infrastructure_manifest_id
        AND infrastructure.status = 'applied'
       WHERE effect.intent_id = $1 AND effect.project_id = $2
         AND effect.environment_name = 'dev'
         AND effect.effect_type = 'ecr.build_push_immutable_image'
         AND effect.status = 'uncertain'
         AND intent.release_manifest_id IS NULL
         AND infrastructure.id = $3 AND infrastructure.revision = $4::bigint`,
      [intentId, draft.projectId, draft.infrastructureManifestId, draft.infrastructureRevision],
    );
    if (rows.length !== 1 || typeof rows[0].repositoryName !== "string"
      || typeof rows[0].repositoryUrl !== "string") {
      return { state: "blocked" as const, safeCodes: ["FIRST_RELEASE_IMAGE_RECONCILIATION_NOT_ELIGIBLE"] };
    }
    const effect = rows[0];
    const commitSha = draft.releaseDraft.commitSha;
    const region = this.config.get<string>("AWS_REGION", "");
    const ecr = new ECRClient({ region });
    const inspectionFingerprint = canonicalSha256({
      schemaVersion: 1,
      sideEffectId: effect.id,
      infrastructureManifestId: draft.infrastructureManifestId,
      infrastructureRevision: draft.infrastructureRevision,
      commitSha,
    });
    const adapter = {
      policy: "deployguard.side-effect-reconciliation/read-only-v1" as const,
      adapterId: "deployguard.ecr-image-absence.v1",
      effectType: "ecr.build_push_immutable_image",
      inspect: async (context: any) => {
        if (!context.readOnly || context.signal.aborted || !context.isLeaseTrusted()) throw new Error("FIRST_RELEASE_RECONCILIATION_OWNERSHIP_LOST");
        try {
          const response = await ecr.send(new DescribeImagesCommand({
            repositoryName: effect.repositoryName,
            imageIds: [{ imageTag: commitSha }],
          }), { abortSignal: context.signal });
          const images = response.imageDetails ?? [];
          if (images.length === 0) {
            return { classification: "failed" as const, safeFailureCode: "FIRST_RELEASE_IMAGE_ABSENT_CONFIRMED", evidenceFingerprint: inspectionFingerprint };
          }
          const digest = images.length === 1 ? images[0].imageDigest : null;
          if (typeof digest !== "string" || !/^sha256:[0-9a-f]{64}$/.test(digest)) {
            return { classification: "manual_review" as const, safeFailureCode: "FIRST_RELEASE_IMAGE_PRESENT_REQUIRES_RECONCILIATION", evidenceFingerprint: inspectionFingerprint };
          }
          return {
            classification: "succeeded" as const,
            safeEvidenceCode: "FIRST_RELEASE_IMAGE_DIGEST_VERIFIED",
            evidenceFingerprint: inspectionFingerprint,
            resultFingerprint: canonicalSha256({ repositoryUrl: effect.repositoryUrl, commitSha, digest }),
            externalReferenceHash: canonicalSha256({ repositoryUrl: effect.repositoryUrl, digest }),
          };
        } catch (error: any) {
          if (error?.name === "ImageNotFoundException") {
            return { classification: "failed" as const, safeFailureCode: "FIRST_RELEASE_IMAGE_ABSENT_CONFIRMED", evidenceFingerprint: inspectionFingerprint };
          }
          throw new Error("FIRST_RELEASE_IMAGE_INSPECTION_FAILED");
        }
      },
    };
    const composed = this.composition.getInactiveComposition();
    if (!composed?.allows(draft.projectId, "dev")) {
      return { state: "blocked" as const, safeCodes: ["FIRST_RELEASE_COMPOSITION_NOT_READY"] };
    }
    const result = await composed.reconciliationCoordinator.coordinate({
      workerId: `${this.config.get<string>("TWO_LANE_RELEASE_WORKER_ID", "one-shot")}:reconcile`,
      leaseTtlMs: 60_000,
      request: {
        sideEffectId: effect.id,
        operationId: this.deterministicId(intentId, `image-reconcile-${effect.reconciliationCount}`),
        idempotencyKey: canonicalSha256({ schemaVersion: 1, intentId, sideEffectId: effect.id, operation: "image-reconcile", attempt: effect.reconciliationCount }),
        inspectionFingerprint,
        timeoutMs: 30_000,
        adapter,
      },
    });
    const classification = result.disposition === "coordinated"
      ? result.result.disposition === "classified" || result.result.disposition === "replayed"
        ? result.result.classification
        : null
      : result.disposition === "terminal_evidence_replayed"
        ? result.classification
        : null;
    return classification === "failed"
      ? { state: "reconciled" as const, safeCodes: ["FIRST_RELEASE_IMAGE_ABSENT_CONFIRMED"] }
      : classification === "succeeded"
        ? { state: "reconciled" as const, safeCodes: ["FIRST_RELEASE_IMAGE_DIGEST_VERIFIED"] }
        : { state: "blocked" as const, safeCodes: ["FIRST_RELEASE_IMAGE_RECONCILIATION_REQUIRED"] };
  }

  private deterministicId(intentId: string, suffix: string) {
    const h = createHash("sha256").update(`${intentId}:${suffix}`).digest("hex");
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
  }
}
