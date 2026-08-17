import { createHash } from "node:crypto";
import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { DataSource, EntityManager } from "typeorm";
import { canonicalSha256 } from "../contracts/canonical-json";
import { DeployGuardWorkerEnvelopeV1 } from "../contracts/worker-envelope.types";
import {
  validateWorkerEnvelopeV1,
  workerEnvelopeJobId,
  workerEnvelopePayloadForHash,
} from "../contracts/worker-envelope.validator";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;
const ACTOR = /^[A-Za-z0-9._:@/-]{1,160}$/;
const TOKEN = /^[1-9][0-9]*$/;
const SERIALIZATION_ATTEMPTS = 3;
const APPLY_ENVELOPE_TTL_MS = 24 * 60 * 60 * 1000;

export type InfrastructurePlanCompletionContinuationInput = {
  parentIntentId: string;
  parentCanonicalIdempotencyKey: string;
  parentRequestFingerprint: string;
  infrastructureManifestId: string;
  initialReleaseDraftId: string;
  planOutboxId: string;
  planArtifactSha256: string;
  planInputFingerprint: string;
  operationLeaseId: string;
  operationWorkerId: string;
  operationFencingToken: string;
  ownershipLeaseId: string;
  ownershipActorId: string;
  ownershipFencingToken: string;
  /** Recovery is valid only for the historical schema-gap failure after a saved plan. */
  terminalRecovery?: boolean;
};

export type InfrastructurePlanCompletionContinuationResult = {
  parentIntentId: string;
  parentStatus: "plan_completed";
  applyIntentId: string;
  applyOutboxId: string;
  applyOutboxStatus: "pending";
  planArtifactSha256: string;
  replayed: boolean;
};

export type InfrastructurePlanCompletionErrorCode =
  | "INFRASTRUCTURE_PLAN_CONTINUATION_INPUT_INVALID"
  | "INFRASTRUCTURE_PLAN_CONTINUATION_PARENT_INVALID"
  | "INFRASTRUCTURE_PLAN_CONTINUATION_IMMUTABLE_EVIDENCE_CONFLICT"
  | "INFRASTRUCTURE_PLAN_CONTINUATION_PLAN_OUTBOX_INVALID"
  | "INFRASTRUCTURE_PLAN_CONTINUATION_FENCE_LOST"
  | "INFRASTRUCTURE_PLAN_CONTINUATION_CONFLICT";

export class InfrastructurePlanCompletionContinuationError extends Error {
  constructor(readonly code: InfrastructurePlanCompletionErrorCode) {
    super(code);
    this.name = "InfrastructurePlanCompletionContinuationError";
  }
}

type ParentRow = {
  id: string;
  schemaVersion: number;
  projectId: string;
  environmentName: string;
  requestedByUserId: number | null;
  kind: string;
  classification: string | null;
  status: string;
  failureCode: string | null;
  canonicalIdempotencyKey: string;
  requestFingerprint: string;
  infrastructureManifestId: string | null;
  releaseManifestId: string | null;
  requestPayload: Record<string, unknown>;
  decision: Record<string, unknown> | null;
};

type ManifestRow = {
  id: string;
  projectId: string;
  environmentName: string;
  revision: string;
  status: string;
  specHash: string;
  stateKey: string;
  planArtifactReference: Record<string, unknown> | null;
  planArtifactSha256: string | null;
  planInputFingerprint: string | null;
  appliedAt: Date | null;
};

type DraftRow = {
  id: string;
  intentId: string;
  projectId: string;
  environmentName: string;
  infrastructureManifestId: string;
  infrastructureRevision: string;
  draftHash: string;
  releaseDraft: Record<string, unknown>;
};

type OutboxRow = {
  id: string;
  intentId: string;
  aggregateType: string;
  aggregateId: string;
  eventType: string;
  workerEnvelope: DeployGuardWorkerEnvelopeV1;
  payloadSha256: string;
  status: string;
  attemptCount: number;
  claimedBy: string | null;
  claimExpiresAt: Date | null;
  publishedJobId: string | null;
  publishedAt: Date | null;
};

type ApplyIntentRow = {
  id: string;
  projectId: string;
  environmentName: string;
  requestedByUserId: number | null;
  kind: string;
  classification: string | null;
  status: string;
  canonicalIdempotencyKey: string;
  requestFingerprint: string;
  requestPayload: Record<string, unknown>;
  decision: Record<string, unknown> | null;
  infrastructureManifestId: string | null;
  releaseManifestId: string | null;
};

/**
 * Inactive infrastructure-plan continuation boundary.
 *
 * This service is deliberately not called by a worker or HTTP route. It exists
 * so a future infrastructure-plan worker can commit the saved-plan outcome
 * without abusing the terminal complete() or retry-oriented release() paths.
 */
@Injectable()
export class InfrastructurePlanCompletionContinuationService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly config: ConfigService,
  ) {}

  async complete(
    input: InfrastructurePlanCompletionContinuationInput,
  ): Promise<InfrastructurePlanCompletionContinuationResult> {
    this.assertInput(input);
    for (let attempt = 1; attempt <= SERIALIZATION_ATTEMPTS; attempt += 1) {
      try {
        return await this.dataSource.transaction(
          "SERIALIZABLE",
          (manager) => this.completeInTransaction(manager, input),
        );
      } catch (error) {
        if (
          attempt === SERIALIZATION_ATTEMPTS
          || !this.isSerializationFailure(error)
        ) {
          throw error;
        }
      }
    }
    throw new InfrastructurePlanCompletionContinuationError(
      "INFRASTRUCTURE_PLAN_CONTINUATION_CONFLICT",
    );
  }

  private async completeInTransaction(
    manager: EntityManager,
    input: InfrastructurePlanCompletionContinuationInput,
  ): Promise<InfrastructurePlanCompletionContinuationResult> {
    await manager.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      `deployguard:infrastructure-plan-continuation:${input.parentIntentId}`,
    ]);
    const parent = await this.lockParent(manager, input.parentIntentId);
    if (!parent || !this.parentIdentityMatches(parent, input)) {
      throw new InfrastructurePlanCompletionContinuationError(
        "INFRASTRUCTURE_PLAN_CONTINUATION_PARENT_INVALID",
      );
    }
    if (
      parent.schemaVersion !== 1
      || parent.environmentName !== "dev"
      || parent.classification !== "infrastructure_change"
      || !["deploy", "plan"].includes(parent.kind)
      || parent.releaseManifestId !== null
      || !["running", "plan_completed"].includes(parent.status)
        && !(input.terminalRecovery === true
          && parent.status === "failed"
          && parent.failureCode === "INFRASTRUCTURE_PLAN_CONTINUATION_FAILED")
    ) {
      throw new InfrastructurePlanCompletionContinuationError(
        "INFRASTRUCTURE_PLAN_CONTINUATION_PARENT_INVALID",
      );
    }

    const manifest = await this.lockManifest(
      manager,
      input.infrastructureManifestId,
    );
    const draft = await this.lockDraft(manager, input.initialReleaseDraftId);
    this.assertImmutableEvidence(parent, manifest, draft, input);
    const planOutbox = await this.lockPlanOutbox(
      manager,
      input.planOutboxId,
      parent.id,
    );
    this.assertDeliveredPlanOutbox(planOutbox, parent, input);

    const continuationIdentity = this.continuationIdentity(
      parent,
      manifest,
      draft,
      input,
    );
    const applyIntentId = deterministicUuid(
      `deployguard:infrastructure-apply:${continuationIdentity.canonicalKey}`,
    );

    if (parent.status === "plan_completed") {
      await this.assertReleasedFences(manager, parent, input);
      const replay = await this.assertExistingContinuation(
        manager,
        parent,
        manifest,
        continuationIdentity,
        applyIntentId,
      );
      return this.result(parent.id, replay.intent.id, replay.outbox.id, input, true);
    }

    await this.assertActiveFences(manager, parent, input);
    const nowRows = this.rows<{ now: Date }>(
      await manager.query(`SELECT clock_timestamp() AS "now"`),
    );
    const now = new Date(nowRows[0].now);
    const applyIntent = await this.createOrReuseApplyIntent(
      manager,
      parent,
      manifest,
      continuationIdentity,
      applyIntentId,
      now,
    );
    const applyOutbox = await this.createOrReuseApplyOutbox(
      manager,
      parent,
      manifest,
      applyIntent,
      now,
    );

    if (!input.terminalRecovery) {
      const transitioned = this.rows<{ id: string }>(
        await manager.query(
          `UPDATE deployment_intents
           SET status = 'plan_completed',
               failure_code = NULL,
               failure_message = NULL,
               completed_at = NULL,
               updated_at = clock_timestamp()
           WHERE id = $1 AND status = 'running'
           RETURNING id`,
          [parent.id],
        ),
      );
      if (transitioned.length !== 1) {
        throw new InfrastructurePlanCompletionContinuationError(
          "INFRASTRUCTURE_PLAN_CONTINUATION_CONFLICT",
        );
      }
    }
    await this.releaseFences(manager, parent, input);
    return this.result(
      parent.id,
      applyIntent.id,
      applyOutbox.id,
      input,
      false,
    );
  }

  private async lockParent(manager: EntityManager, id: string) {
    const rows = this.rows<ParentRow>(
      await manager.query(
        `SELECT id, schema_version AS "schemaVersion",
                project_id AS "projectId",
                environment_name AS "environmentName",
                requested_by_user_id AS "requestedByUserId",
                kind, classification, status, failure_code AS "failureCode",
                canonical_idempotency_key AS "canonicalIdempotencyKey",
                request_fingerprint AS "requestFingerprint",
                infrastructure_manifest_id AS "infrastructureManifestId",
                release_manifest_id AS "releaseManifestId",
                request_payload AS "requestPayload", decision
         FROM deployment_intents
         WHERE id = $1
         FOR UPDATE`,
        [id],
      ),
    );
    return rows[0] || null;
  }

  private async lockManifest(manager: EntityManager, id: string) {
    const rows = this.rows<ManifestRow>(
      await manager.query(
        `SELECT id, project_id AS "projectId",
                environment_name AS "environmentName", revision, status,
                spec_hash AS "specHash", state_key AS "stateKey",
                plan_artifact_reference AS "planArtifactReference",
                plan_artifact_sha256 AS "planArtifactSha256",
                plan_input_fingerprint AS "planInputFingerprint",
                applied_at AS "appliedAt"
         FROM infrastructure_manifests
         WHERE id = $1
         FOR UPDATE`,
        [id],
      ),
    );
    return rows[0] || null;
  }

  private async lockDraft(manager: EntityManager, id: string) {
    const rows = this.rows<DraftRow>(
      await manager.query(
        `SELECT id, intent_id AS "intentId", project_id AS "projectId",
                environment_name AS "environmentName",
                infrastructure_manifest_id AS "infrastructureManifestId",
                infrastructure_revision AS "infrastructureRevision",
                draft_hash AS "draftHash", release_draft AS "releaseDraft"
         FROM initial_release_drafts
         WHERE id = $1
         FOR SHARE`,
        [id],
      ),
    );
    return rows[0] || null;
  }

  private async lockPlanOutbox(
    manager: EntityManager,
    id: string,
    parentIntentId: string,
  ) {
    const rows = this.rows<OutboxRow>(
      await manager.query(
        `SELECT id, intent_id AS "intentId",
                aggregate_type AS "aggregateType",
                aggregate_id AS "aggregateId", event_type AS "eventType",
                worker_envelope AS "workerEnvelope",
                payload_sha256 AS "payloadSha256", status,
                attempt_count AS "attemptCount", claimed_by AS "claimedBy",
                claim_expires_at AS "claimExpiresAt",
                published_job_id AS "publishedJobId",
                published_at AS "publishedAt"
         FROM orchestration_outbox
         WHERE intent_id = $1
           AND event_type = 'intent.infrastructure.plan'
         FOR UPDATE`,
        [parentIntentId],
      ),
    );
    return rows.length === 1 && rows[0].id === id ? rows[0] : null;
  }

  private parentIdentityMatches(
    parent: ParentRow,
    input: InfrastructurePlanCompletionContinuationInput,
  ) {
    return parent.id === input.parentIntentId
      && parent.canonicalIdempotencyKey
        === input.parentCanonicalIdempotencyKey
      && parent.requestFingerprint === input.parentRequestFingerprint
      && canonicalSha256(parent.requestPayload) === parent.requestFingerprint
      && parent.infrastructureManifestId === input.infrastructureManifestId;
  }

  private assertImmutableEvidence(
    parent: ParentRow,
    manifest: ManifestRow | null,
    draft: DraftRow | null,
    input: InfrastructurePlanCompletionContinuationInput,
  ) {
    const reference = manifest?.planArtifactReference;
    const decision = parent.decision;
    if (
      !manifest
      || !draft
      || manifest.projectId !== parent.projectId
      || manifest.environmentName !== parent.environmentName
      || manifest.status !== "planned"
      || manifest.appliedAt !== null
      || manifest.planArtifactSha256 !== input.planArtifactSha256
      || manifest.planInputFingerprint !== input.planInputFingerprint
      || !reference
      || reference.phase !== "planned"
      || reference.artifactSha256 !== input.planArtifactSha256
      || reference.inputFingerprint !== input.planInputFingerprint
      || reference.stateKey !== manifest.stateKey
      || typeof reference.workspaceRef !== "string"
      || reference.workspaceRef.length === 0
      || !reference.planSummary
      || typeof reference.planSummary !== "object"
      || draft.intentId !== parent.id
      || draft.projectId !== parent.projectId
      || draft.environmentName !== parent.environmentName
      || draft.infrastructureManifestId !== manifest.id
      || String(draft.infrastructureRevision) !== String(manifest.revision)
      || canonicalSha256(draft.releaseDraft) !== draft.draftHash
      || !decision
      || decision.classification !== "infrastructure_change"
      || decision.executionLane !== "infrastructure"
      || decision.desiredInfrastructureManifestId !== manifest.id
      || decision.desiredReleaseManifestId !== null
    ) {
      throw new InfrastructurePlanCompletionContinuationError(
        "INFRASTRUCTURE_PLAN_CONTINUATION_IMMUTABLE_EVIDENCE_CONFLICT",
      );
    }
  }

  private assertDeliveredPlanOutbox(
    outbox: OutboxRow | null,
    parent: ParentRow,
    input: InfrastructurePlanCompletionContinuationInput,
  ) {
    if (
      !outbox
      || outbox.intentId !== parent.id
      || outbox.aggregateType !== "deployment_intent"
      || outbox.aggregateId !== parent.id
      || outbox.eventType !== "intent.infrastructure.plan"
      || outbox.status !== "published"
      || outbox.attemptCount < 1
      || outbox.claimedBy !== null
      || outbox.claimExpiresAt !== null
      || !outbox.publishedAt
      || !outbox.publishedJobId
      || outbox.payloadSha256 !== outbox.workerEnvelope?.idempotency?.payloadSha256
    ) {
      throw new InfrastructurePlanCompletionContinuationError(
        "INFRASTRUCTURE_PLAN_CONTINUATION_PLAN_OUTBOX_INVALID",
      );
    }
    let envelope: DeployGuardWorkerEnvelopeV1;
    try {
      const producedAt = new Date(outbox.workerEnvelope.producer.producedAt);
      envelope = validateWorkerEnvelopeV1(
        outbox.workerEnvelope,
        new Date(producedAt.getTime() - 1),
      );
    } catch {
      throw new InfrastructurePlanCompletionContinuationError(
        "INFRASTRUCTURE_PLAN_CONTINUATION_PLAN_OUTBOX_INVALID",
      );
    }
    if (
      envelope.protocol.messageType !== "intent.infrastructure.plan"
      || envelope.identity.intentId !== parent.id
      || envelope.identity.projectId !== parent.projectId
      || envelope.identity.environmentName !== parent.environmentName
      || envelope.identity.infrastructureManifestId
        !== input.infrastructureManifestId
      || envelope.identity.releaseManifestId !== null
      || envelope.routing.lane !== "infrastructure"
      || envelope.routing.operation !== "plan"
      || envelope.routing.queue !== "deployguard-infrastructure-v1"
      || envelope.idempotency.canonicalKey
        !== parent.canonicalIdempotencyKey
      || workerEnvelopeJobId(envelope) !== outbox.publishedJobId
    ) {
      throw new InfrastructurePlanCompletionContinuationError(
        "INFRASTRUCTURE_PLAN_CONTINUATION_PLAN_OUTBOX_INVALID",
      );
    }
  }

  private async assertActiveFences(
    manager: EntityManager,
    parent: ParentRow,
    input: InfrastructurePlanCompletionContinuationInput,
  ) {
    const operation = await manager.query(
      `SELECT id
       FROM project_operation_leases
       WHERE id = $1 AND intent_id = $2 AND project_id = $3
         AND environment_name = $4 AND lane = 'infrastructure'
         AND scope = 'plan' AND owner_worker_id = $5
         AND fencing_token = $6::bigint
         AND status IN ('acquired','heartbeat_active')
         AND expires_at > clock_timestamp()
       FOR UPDATE`,
      [
        input.operationLeaseId,
        parent.id,
        parent.projectId,
        parent.environmentName,
        input.operationWorkerId,
        input.operationFencingToken,
      ],
    );
    const ownership = await manager.query(
      `SELECT id
       FROM project_release_lane_ownerships
       WHERE project_id = $1 AND environment_name = $2
         AND owner_lane = 'v1' AND lease_id = $3 AND actor_id = $4
         AND fencing_token = $5::bigint
         AND deployment_intent_id = $6 AND operation_lease_id = $7
         AND status IN ('acquired','heartbeat_active')
         AND expires_at > clock_timestamp()
       FOR UPDATE`,
      [
        parent.projectId,
        parent.environmentName,
        input.ownershipLeaseId,
        input.ownershipActorId,
        input.ownershipFencingToken,
        parent.id,
        input.operationLeaseId,
      ],
    );
    if (operation.length !== 1 || ownership.length !== 1) {
      throw new InfrastructurePlanCompletionContinuationError(
        "INFRASTRUCTURE_PLAN_CONTINUATION_FENCE_LOST",
      );
    }
  }

  private async assertReleasedFences(
    manager: EntityManager,
    parent: ParentRow,
    input: InfrastructurePlanCompletionContinuationInput,
  ) {
    const operation = await manager.query(
      `SELECT id
       FROM project_operation_leases
       WHERE id = $1 AND intent_id = $2 AND project_id = $3
         AND environment_name = $4 AND lane = 'infrastructure'
         AND scope = 'plan' AND owner_worker_id = $5
         AND fencing_token = $6::bigint AND status = 'released'
       FOR SHARE`,
      [
        input.operationLeaseId,
        parent.id,
        parent.projectId,
        parent.environmentName,
        input.operationWorkerId,
        input.operationFencingToken,
      ],
    );
    const ownership = await manager.query(
      `SELECT id
       FROM project_release_lane_ownerships
       WHERE project_id = $1 AND environment_name = $2
         AND owner_lane = 'v1' AND lease_id = $3 AND actor_id = $4
         AND fencing_token = $5::bigint
         AND deployment_intent_id = $6 AND operation_lease_id = $7
         AND status = 'released'
       FOR SHARE`,
      [
        parent.projectId,
        parent.environmentName,
        input.ownershipLeaseId,
        input.ownershipActorId,
        input.ownershipFencingToken,
        parent.id,
        input.operationLeaseId,
      ],
    );
    if (operation.length !== 1 || ownership.length !== 1) {
      throw new InfrastructurePlanCompletionContinuationError(
        "INFRASTRUCTURE_PLAN_CONTINUATION_FENCE_LOST",
      );
    }
  }

  private continuationIdentity(
    parent: ParentRow,
    manifest: ManifestRow,
    draft: DraftRow,
    input: InfrastructurePlanCompletionContinuationInput,
  ) {
    const requestPayload = {
      schemaVersion: 1,
      operation: "infrastructure_apply_continuation",
      parentPlanIntentId: parent.id,
      parentCanonicalIdempotencyKey: parent.canonicalIdempotencyKey,
      parentRequestFingerprint: parent.requestFingerprint,
      infrastructureManifestId: manifest.id,
      infrastructureRevision: String(manifest.revision),
      infrastructureSpecHash: manifest.specHash,
      initialReleaseDraftId: draft.id,
      initialReleaseDraftHash: draft.draftHash,
      planArtifactSha256: input.planArtifactSha256,
      planInputFingerprint: input.planInputFingerprint,
    };
    return {
      requestPayload,
      canonicalKey: canonicalSha256({
        schemaVersion: 1,
        operation: "infrastructure_apply_continuation",
        parentPlanIntentId: parent.id,
        planArtifactSha256: input.planArtifactSha256,
        planInputFingerprint: input.planInputFingerprint,
        initialReleaseDraftHash: draft.draftHash,
      }),
      requestFingerprint: canonicalSha256(requestPayload),
    };
  }

  private async createOrReuseApplyIntent(
    manager: EntityManager,
    parent: ParentRow,
    manifest: ManifestRow,
    identity: ReturnType<
      InfrastructurePlanCompletionContinuationService["continuationIdentity"]
    >,
    applyIntentId: string,
    now: Date,
  ) {
    const decision = {
      schemaVersion: 1,
      intentId: applyIntentId,
      classification: "infrastructure_change",
      reasonCodes: [
        "INFRASTRUCTURE_PLAN_COMPLETED",
        "INFRASTRUCTURE_APPLY_APPROVAL_REQUIRED",
      ],
      currentAppliedInfrastructureManifestId: null,
      desiredInfrastructureManifestId: manifest.id,
      currentStableReleaseManifestId: null,
      desiredReleaseManifestId: null,
      infrastructureChangedPaths: [],
      releaseChangedPaths: [],
      approvalRequired: true,
      executionLane: "infrastructure",
      blockedReasons: [],
    };
    const existingForParent = this.rows<ApplyIntentRow>(
      await manager.query(
        `SELECT id, project_id AS "projectId",
                environment_name AS "environmentName",
                requested_by_user_id AS "requestedByUserId",
                kind, classification, status,
                canonical_idempotency_key AS "canonicalIdempotencyKey",
                request_fingerprint AS "requestFingerprint",
                request_payload AS "requestPayload", decision,
                infrastructure_manifest_id AS "infrastructureManifestId",
                release_manifest_id AS "releaseManifestId"
         FROM deployment_intents
         WHERE project_id = $1 AND environment_name = $2
           AND kind = 'apply'
           AND request_payload->>'parentPlanIntentId' = $3
         FOR UPDATE`,
        [parent.projectId, parent.environmentName, parent.id],
      ),
    );
    if (
      existingForParent.length > 1
      || (
        existingForParent.length === 1
        && (
          existingForParent[0].id !== applyIntentId
          || existingForParent[0].canonicalIdempotencyKey
            !== identity.canonicalKey
        )
      )
    ) {
      throw new InfrastructurePlanCompletionContinuationError(
        "INFRASTRUCTURE_PLAN_CONTINUATION_CONFLICT",
      );
    }
    if (existingForParent.length === 0) await manager.query(
      `INSERT INTO deployment_intents (
         id, schema_version, project_id, environment_name,
         requested_by_user_id, kind, classification, status,
         client_idempotency_key, canonical_idempotency_key,
         request_fingerprint, request_payload, decision,
         infrastructure_manifest_id, release_manifest_id,
         source_pipeline_run_id, pipeline_run_id, destroy_operation_id,
         failure_code, failure_message, received_at, planned_at,
         enqueued_at, started_at, completed_at, created_at, updated_at
       ) VALUES (
         $1, 1, $2, $3, $4, 'apply', 'infrastructure_change', 'planned',
         $5, $6, $7, $8::jsonb, $9::jsonb, $10, NULL,
         NULL, NULL, NULL, NULL, NULL, $11, $11,
         NULL, NULL, NULL, $11, $11
       )
       ON CONFLICT (project_id, environment_name, canonical_idempotency_key)
       DO NOTHING`,
      [
        applyIntentId,
        parent.projectId,
        parent.environmentName,
        parent.requestedByUserId,
        `infrastructure-apply-continuation:${parent.id}`,
        identity.canonicalKey,
        identity.requestFingerprint,
        JSON.stringify(identity.requestPayload),
        JSON.stringify(decision),
        manifest.id,
        now,
      ],
    );
    const rows = this.rows<ApplyIntentRow>(
      await manager.query(
        `SELECT id, project_id AS "projectId",
                environment_name AS "environmentName",
                requested_by_user_id AS "requestedByUserId",
                kind, classification, status,
                canonical_idempotency_key AS "canonicalIdempotencyKey",
                request_fingerprint AS "requestFingerprint",
                request_payload AS "requestPayload", decision,
                infrastructure_manifest_id AS "infrastructureManifestId",
                release_manifest_id AS "releaseManifestId"
         FROM deployment_intents
         WHERE project_id = $1 AND environment_name = $2
           AND canonical_idempotency_key = $3
         FOR UPDATE`,
        [parent.projectId, parent.environmentName, identity.canonicalKey],
      ),
    );
    const intent = rows[0];
    if (
      !intent
      || intent.id !== applyIntentId
      || intent.kind !== "apply"
      || intent.classification !== "infrastructure_change"
      || intent.status !== "planned"
      || intent.infrastructureManifestId !== manifest.id
      || intent.releaseManifestId !== null
      || intent.requestFingerprint !== identity.requestFingerprint
      || canonicalSha256(intent.requestPayload)
        !== canonicalSha256(identity.requestPayload)
      || intent.decision?.intentId !== applyIntentId
      || intent.decision?.approvalRequired !== true
      || intent.decision?.executionLane !== "infrastructure"
    ) {
      throw new InfrastructurePlanCompletionContinuationError(
        "INFRASTRUCTURE_PLAN_CONTINUATION_CONFLICT",
      );
    }
    return intent;
  }

  private async createOrReuseApplyOutbox(
    manager: EntityManager,
    parent: ParentRow,
    manifest: ManifestRow,
    applyIntent: ApplyIntentRow,
    now: Date,
  ) {
    const [parentDelivery] = await manager.query(
      `SELECT worker_envelope AS "workerEnvelope"
       FROM orchestration_outbox
       WHERE intent_id = $1 AND event_type = 'intent.infrastructure.plan'
         AND status = 'published'
       ORDER BY created_at ASC
       LIMIT 1`,
      [parent.id],
    ) as Array<{ workerEnvelope: DeployGuardWorkerEnvelopeV1 }>;
    const shared = Boolean(parentDelivery?.workerEnvelope?.identity?.workspaceId);
    const envelope = {
      protocol: {
        name: "deployguard.worker",
        schemaVersion: 1,
        messageType: "intent.infrastructure.apply",
        minimumWorkerProtocol: 1,
        maximumWorkerProtocol: 1,
      },
      producer: {
        service: "deployguard-api",
        serviceVersion: this.config.get<string>("DEPLOYGUARD_VERSION", "local"),
        gitSha: this.config.get<string>("GIT_SHA", "unknown"),
        producedAt: now.toISOString(),
      },
      identity: {
        ...(shared
          ? { workspaceId: parentDelivery.workerEnvelope.identity.workspaceId }
          : {}),
        intentId: applyIntent.id,
        projectId: parent.projectId,
        environmentName: parent.environmentName,
        pipelineRunId: null,
        destroyOperationId: null,
        infrastructureManifestId: manifest.id,
        releaseManifestId: null,
      },
      ...(shared ? {
        authorization: parentDelivery.workerEnvelope.authorization,
        expectations: {
          ...parentDelivery.workerEnvelope.expectations!,
          infrastructureRevision: String(manifest.revision),
          releaseRevision: null,
        },
      } : {}),
      routing: {
        lane: "infrastructure",
        operation: "apply",
        queue: "deployguard-infrastructure-v1",
      },
      idempotency: {
        canonicalKey: applyIntent.canonicalIdempotencyKey,
        payloadSha256: "0".repeat(64),
        attempt: 1,
        replayOfJobId: null,
      },
      execution: {
        mode: "full",
        resumeFromStage: null,
        reusableCheckpointIds: [],
        invalidatedCheckpointIds: [],
        reasonCodes: [
          "INFRASTRUCTURE_PLAN_COMPLETED",
          "INFRASTRUCTURE_APPLY_APPROVAL_REQUIRED",
        ],
        fencingTokenRequired: true,
      },
      trace: {
        correlationId: applyIntent.id,
        causationId: parent.id,
        actorUserId: parent.requestedByUserId,
      },
      expiresAt: new Date(now.getTime() + APPLY_ENVELOPE_TTL_MS).toISOString(),
    } as DeployGuardWorkerEnvelopeV1;
    envelope.idempotency.payloadSha256 = canonicalSha256(
      workerEnvelopePayloadForHash(envelope),
    );
    const validated = validateWorkerEnvelopeV1(
      envelope,
      new Date(now.getTime() - 1),
    );
    await manager.query(
      `INSERT INTO orchestration_outbox (
         intent_id, aggregate_type, aggregate_id, event_type,
         worker_envelope, payload_sha256, status, attempt_count,
         available_at, claimed_by, claim_expires_at, claim_fencing_token,
         published_job_id, last_error, published_at, created_at, updated_at
       ) VALUES (
         $1, 'deployment_intent', $1, 'intent.infrastructure.apply',
         $2::jsonb, $3, 'pending', 0, $4, NULL, NULL, 0,
         NULL, NULL, NULL, $4, $4
       )
       ON CONFLICT (intent_id, event_type, payload_sha256) DO NOTHING`,
      [
        applyIntent.id,
        JSON.stringify(validated),
        validated.idempotency.payloadSha256,
        now,
      ],
    );
    const rows = this.rows<OutboxRow>(
      await manager.query(
        `SELECT id, intent_id AS "intentId",
                aggregate_type AS "aggregateType",
                aggregate_id AS "aggregateId", event_type AS "eventType",
                worker_envelope AS "workerEnvelope",
                payload_sha256 AS "payloadSha256", status,
                attempt_count AS "attemptCount", claimed_by AS "claimedBy",
                claim_expires_at AS "claimExpiresAt",
                published_job_id AS "publishedJobId",
                published_at AS "publishedAt"
         FROM orchestration_outbox
         WHERE intent_id = $1
         FOR UPDATE`,
        [applyIntent.id],
      ),
    );
    const outbox = rows[0];
    if (
      rows.length !== 1
      || !outbox
      || outbox.aggregateType !== "deployment_intent"
      || outbox.aggregateId !== applyIntent.id
      || outbox.status !== "pending"
      || outbox.attemptCount !== 0
      || outbox.claimedBy !== null
      || outbox.claimExpiresAt !== null
      || outbox.publishedJobId !== null
      || outbox.publishedAt !== null
      || outbox.payloadSha256
        !== outbox.workerEnvelope?.idempotency?.payloadSha256
      || outbox.workerEnvelope.identity.intentId !== applyIntent.id
      || outbox.workerEnvelope.identity.infrastructureManifestId !== manifest.id
      || outbox.workerEnvelope.protocol.messageType
        !== "intent.infrastructure.apply"
    ) {
      throw new InfrastructurePlanCompletionContinuationError(
        "INFRASTRUCTURE_PLAN_CONTINUATION_CONFLICT",
      );
    }
    return outbox;
  }

  private async assertExistingContinuation(
    manager: EntityManager,
    parent: ParentRow,
    manifest: ManifestRow,
    identity: ReturnType<
      InfrastructurePlanCompletionContinuationService["continuationIdentity"]
    >,
    applyIntentId: string,
  ) {
    const rows = this.rows<ApplyIntentRow>(
      await manager.query(
        `SELECT id, project_id AS "projectId",
                environment_name AS "environmentName",
                requested_by_user_id AS "requestedByUserId",
                kind, classification, status,
                canonical_idempotency_key AS "canonicalIdempotencyKey",
                request_fingerprint AS "requestFingerprint",
                request_payload AS "requestPayload", decision,
                infrastructure_manifest_id AS "infrastructureManifestId",
                release_manifest_id AS "releaseManifestId"
         FROM deployment_intents
         WHERE project_id = $1 AND environment_name = $2
           AND canonical_idempotency_key = $3
         FOR UPDATE`,
        [parent.projectId, parent.environmentName, identity.canonicalKey],
      ),
    );
    const intent = rows[0];
    if (
      rows.length !== 1
      || !intent
      || intent.id !== applyIntentId
      || intent.status !== "planned"
      || intent.kind !== "apply"
      || intent.classification !== "infrastructure_change"
      || intent.infrastructureManifestId !== manifest.id
      || intent.releaseManifestId !== null
      || intent.requestFingerprint !== identity.requestFingerprint
      || canonicalSha256(intent.requestPayload)
        !== canonicalSha256(identity.requestPayload)
      || intent.decision?.approvalRequired !== true
    ) {
      throw new InfrastructurePlanCompletionContinuationError(
        "INFRASTRUCTURE_PLAN_CONTINUATION_CONFLICT",
      );
    }
    const outboxes = this.rows<OutboxRow>(
      await manager.query(
        `SELECT id, intent_id AS "intentId",
                aggregate_type AS "aggregateType",
                aggregate_id AS "aggregateId", event_type AS "eventType",
                worker_envelope AS "workerEnvelope",
                payload_sha256 AS "payloadSha256", status,
                attempt_count AS "attemptCount", claimed_by AS "claimedBy",
                claim_expires_at AS "claimExpiresAt",
                published_job_id AS "publishedJobId",
                published_at AS "publishedAt"
         FROM orchestration_outbox
         WHERE intent_id = $1
         FOR UPDATE`,
        [intent.id],
      ),
    );
    const outbox = outboxes[0];
    if (
      outboxes.length !== 1
      || !outbox
      || outbox.eventType !== "intent.infrastructure.apply"
      || outbox.status !== "pending"
      || outbox.attemptCount !== 0
      || outbox.claimedBy !== null
      || outbox.publishedJobId !== null
      || outbox.payloadSha256
        !== outbox.workerEnvelope?.idempotency?.payloadSha256
    ) {
      throw new InfrastructurePlanCompletionContinuationError(
        "INFRASTRUCTURE_PLAN_CONTINUATION_CONFLICT",
      );
    }
    return { intent, outbox };
  }

  private async releaseFences(
    manager: EntityManager,
    parent: ParentRow,
    input: InfrastructurePlanCompletionContinuationInput,
  ) {
    const operation = this.rows<{ id: string }>(
      await manager.query(
        `UPDATE project_operation_leases
         SET status = 'released', released_at = clock_timestamp(),
             updated_at = clock_timestamp()
         WHERE id = $1 AND intent_id = $2 AND project_id = $3
           AND environment_name = $4 AND lane = 'infrastructure'
           AND scope = 'plan' AND owner_worker_id = $5
           AND fencing_token = $6::bigint
           AND status IN ('acquired','heartbeat_active')
           AND expires_at > clock_timestamp()
         RETURNING id`,
        [
          input.operationLeaseId,
          parent.id,
          parent.projectId,
          parent.environmentName,
          input.operationWorkerId,
          input.operationFencingToken,
        ],
      ),
    );
    const ownership = this.rows<{ id: string }>(
      await manager.query(
        `UPDATE project_release_lane_ownerships
         SET status = 'released', released_at = clock_timestamp(),
             updated_at = clock_timestamp()
         WHERE project_id = $1 AND environment_name = $2
           AND owner_lane = 'v1' AND lease_id = $3 AND actor_id = $4
           AND fencing_token = $5::bigint
           AND deployment_intent_id = $6 AND operation_lease_id = $7
           AND status IN ('acquired','heartbeat_active')
           AND expires_at > clock_timestamp()
         RETURNING id`,
        [
          parent.projectId,
          parent.environmentName,
          input.ownershipLeaseId,
          input.ownershipActorId,
          input.ownershipFencingToken,
          parent.id,
          input.operationLeaseId,
        ],
      ),
    );
    if (operation.length !== 1 || ownership.length !== 1) {
      throw new InfrastructurePlanCompletionContinuationError(
        "INFRASTRUCTURE_PLAN_CONTINUATION_FENCE_LOST",
      );
    }
  }

  private result(
    parentIntentId: string,
    applyIntentId: string,
    applyOutboxId: string,
    input: InfrastructurePlanCompletionContinuationInput,
    replayed: boolean,
  ): InfrastructurePlanCompletionContinuationResult {
    return {
      parentIntentId,
      parentStatus: "plan_completed",
      applyIntentId,
      applyOutboxId,
      applyOutboxStatus: "pending",
      planArtifactSha256: input.planArtifactSha256,
      replayed,
    };
  }

  private assertInput(input: InfrastructurePlanCompletionContinuationInput) {
    const uuids = [
      input.parentIntentId,
      input.infrastructureManifestId,
      input.initialReleaseDraftId,
      input.planOutboxId,
      input.operationLeaseId,
      input.ownershipLeaseId,
    ];
    if (
      uuids.some((value) => !UUID.test(value))
      || !SHA256.test(input.parentCanonicalIdempotencyKey)
      || !SHA256.test(input.parentRequestFingerprint)
      || !SHA256.test(input.planArtifactSha256)
      || !SHA256.test(input.planInputFingerprint)
      || !ACTOR.test(input.operationWorkerId)
      || !ACTOR.test(input.ownershipActorId)
      || !TOKEN.test(input.operationFencingToken)
      || !TOKEN.test(input.ownershipFencingToken)
    ) {
      throw new InfrastructurePlanCompletionContinuationError(
        "INFRASTRUCTURE_PLAN_CONTINUATION_INPUT_INVALID",
      );
    }
  }

  private rows<T>(result: unknown): T[] {
    if (
      Array.isArray(result)
      && result.length === 2
      && Array.isArray(result[0])
      && typeof result[1] === "number"
    ) {
      return result[0] as T[];
    }
    return Array.isArray(result) ? result as T[] : [];
  }

  private isSerializationFailure(error: unknown) {
    if (!error || typeof error !== "object") return false;
    const code = "code" in error ? String(error.code) : "";
    return code === "40001" || code === "40P01";
  }
}

function deterministicUuid(seed: string) {
  const hash = createHash("sha256").update(seed).digest("hex");
  const variant = ((Number.parseInt(hash[16], 16) & 0x3) | 0x8).toString(16);
  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    `5${hash.slice(13, 16)}`,
    `${variant}${hash.slice(17, 20)}`,
    hash.slice(20, 32),
  ].join("-");
}
