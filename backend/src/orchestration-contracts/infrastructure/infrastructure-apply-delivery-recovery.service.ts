import { createHash } from "node:crypto";
import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { DataSource } from "typeorm";
import { canonicalSha256 } from "../contracts/canonical-json";
import {
  validateWorkerEnvelopeV1,
  workerEnvelopePayloadForHash,
} from "../contracts/worker-envelope.validator";

type RecoveryMode = "context_invalid" | "reconciled_preflight" | "reconciled_preflight_no_effect";

/**
 * Creates a replacement delivery only when a prior apply delivery is proven to
 * have failed before Terraform could have been invoked. The caller must still
 * perform the remote state/AWS read-only evidence checks before calling this
 * durable transition.
 */
@Injectable()
export class InfrastructureApplyDeliveryRecoveryService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly config: ConfigService,
  ) {}

  async recover(failedApplyIntentId: string) {
    return this.dataSource.transaction("SERIALIZABLE", async (manager) => {
      await manager.query(
        "SELECT pg_advisory_xact_lock(hashtext($1))",
        [`deployguard:infrastructure-apply-delivery-recovery:${failedApplyIntentId}`],
      );
      const rows = await manager.query(
        `SELECT child.id AS "childId", child.project_id AS "projectId",
                child.environment_name AS "environmentName",
                child.requested_by_user_id AS "userId", child.status AS "childStatus",
                child.failure_code AS "childFailure", child.request_payload AS "childPayload",
                child.infrastructure_manifest_id AS "manifestId", parent.id AS "parentId",
                parent.status AS "parentStatus", parent.failure_code AS "parentFailure",
                parent.canonical_idempotency_key AS "parentKey",
                parent.request_fingerprint AS "parentFingerprint", manifest.revision,
                manifest.status AS "manifestStatus", manifest.applied_at AS "manifestAppliedAt",
                manifest.spec_hash AS "specHash", manifest.state_key AS "stateKey",
                manifest.plan_artifact_sha256 AS "planHash",
                manifest.plan_input_fingerprint AS "planFingerprint",
                manifest.state_version_id AS "stateVersionId", draft.id AS "draftId",
                draft.draft_hash AS "draftHash", draft.infrastructure_manifest_id AS "draftManifestId",
                outbox.status AS "outboxStatus", outbox.attempt_count AS "attempts",
                outbox.published_job_id IS NOT NULL AS "published",
                outbox.event_type AS "outboxEventType"
           FROM deployment_intents child
           JOIN deployment_intents parent
             ON parent.id = (child.request_payload->>'parentPlanIntentId')::uuid
           JOIN infrastructure_manifests manifest ON manifest.id = child.infrastructure_manifest_id
           JOIN initial_release_drafts draft ON draft.intent_id = parent.id
           JOIN orchestration_outbox outbox
             ON outbox.intent_id = child.id AND outbox.event_type = 'intent.infrastructure.apply'
          WHERE child.id = $1
          FOR UPDATE`,
        [failedApplyIntentId],
      );
      const evidence = rows[0];
      const effects = await manager.query(
        `SELECT status, failure_code AS "failureCode",
                reconciliation_required AS "reconciliationRequired"
           FROM deployment_side_effects
          WHERE intent_id = $1
          FOR UPDATE`,
        [failedApplyIntentId],
      );
      const mode = this.recoveryMode(evidence, effects);
      if (!mode
        || evidence.parentStatus !== "failed"
        || evidence.parentFailure !== "INFRASTRUCTURE_PLAN_CONTINUATION_FAILED"
        || evidence.manifestStatus !== "manual_review"
        || evidence.manifestAppliedAt !== null
        || evidence.stateVersionId !== null
        || evidence.draftManifestId !== evidence.manifestId
        || !this.hash(evidence.planHash)
        || !this.hash(evidence.planFingerprint)
        || !this.hash(evidence.draftHash)
        || evidence.outboxStatus !== "published"
        || evidence.outboxEventType !== "intent.infrastructure.apply"
        || evidence.published !== true
        || Number(evidence.attempts) < 1) {
        throw new Error("INFRASTRUCTURE_APPLY_DELIVERY_RECOVERY_INELIGIBLE");
      }

      const unsafe = await manager.query(
        `SELECT 1 FROM project_operation_leases
          WHERE project_id = $1 AND environment_name = $2
            AND status IN ('acquired','heartbeat_active') AND expires_at > clock_timestamp()
         UNION ALL
         SELECT 1 FROM project_release_lane_ownerships
          WHERE project_id = $1 AND environment_name = $2
            AND status IN ('acquired','heartbeat_active') AND expires_at > clock_timestamp()`,
        [evidence.projectId, evidence.environmentName],
      );
      if (unsafe.length) throw new Error("INFRASTRUCTURE_APPLY_DELIVERY_RECOVERY_CONFLICT");

      const canonicalKey = canonicalSha256({
        operation: "infrastructure_apply_delivery_recovery",
        recoveryMode: mode,
        failedApplyIntentId: evidence.childId,
        planHash: evidence.planHash,
        planFingerprint: evidence.planFingerprint,
        draftHash: evidence.draftHash,
        stateKey: evidence.stateKey,
      });
      const replacementId = deterministicUuid(`apply-delivery-recovery:${canonicalKey}`);
      const existing = await manager.query(
        `SELECT id FROM deployment_intents
          WHERE project_id = $1 AND environment_name = $2
            AND canonical_idempotency_key = $3
          FOR UPDATE`,
        [evidence.projectId, evidence.environmentName, canonicalKey],
      );
      const now = new Date();
      if (!existing.length) {
        await manager.query(
          `INSERT INTO deployment_intents
             (id, schema_version, project_id, environment_name, requested_by_user_id,
              kind, classification, status, client_idempotency_key,
              canonical_idempotency_key, request_fingerprint, request_payload,
              decision, infrastructure_manifest_id, received_at, planned_at,
              created_at, updated_at)
           VALUES
             ($1, 1, $2, $3, $4, 'apply', 'infrastructure_change', 'planned',
              $5, $6, $7, $8::jsonb, $9::jsonb, $10, $11, $11, $11, $11)`,
          [
            replacementId, evidence.projectId, evidence.environmentName, evidence.userId,
            `recovery:${canonicalKey}`, canonicalKey,
            canonicalSha256({ failedApplyIntentId: evidence.childId, planHash: evidence.planHash, draftHash: evidence.draftHash }),
            JSON.stringify({
              operation: "infrastructure_apply_continuation",
              parentPlanIntentId: evidence.parentId,
              recoveryOfApplyIntentId: evidence.childId,
              recoveryMode: mode,
              planArtifactSha256: evidence.planHash,
              planInputFingerprint: evidence.planFingerprint,
              stateKey: evidence.stateKey,
            }),
            JSON.stringify({
              schemaVersion: 1,
              approvalRequired: true,
              executionLane: "infrastructure",
              reasonCodes: ["INFRASTRUCTURE_APPLY_DELIVERY_RECOVERY"],
            }),
            evidence.manifestId,
            now,
          ],
        );
      }
      const intentId = existing[0]?.id || replacementId;
      if (existing.length) {
        const reusedOutbox = await manager.query(
          `SELECT id FROM orchestration_outbox
            WHERE intent_id = $1 AND event_type = 'intent.infrastructure.apply'
              AND status = 'pending' AND attempt_count = 0 AND claimed_by IS NULL
              AND published_at IS NULL
            FOR UPDATE`,
          [intentId],
        );
        if (reusedOutbox.length !== 1) {
          throw new Error("INFRASTRUCTURE_APPLY_DELIVERY_RECOVERY_CONFLICT");
        }
        return {
          applyIntentId: intentId,
          applyOutboxId: reusedOutbox[0].id,
          replayed: true,
          recoveryMode: mode,
        };
      }
      const envelope: any = {
        protocol: {
          name: "deployguard.worker", schemaVersion: 1,
          messageType: "intent.infrastructure.apply", minimumWorkerProtocol: 1,
          maximumWorkerProtocol: 1,
        },
        producer: {
          service: "deployguard-api",
          serviceVersion: this.config.get("DEPLOYGUARD_VERSION", "local"),
          gitSha: this.config.get("GIT_SHA", "unknown"),
          producedAt: now.toISOString(),
        },
        identity: {
          intentId, projectId: evidence.projectId, environmentName: evidence.environmentName,
          pipelineRunId: null, destroyOperationId: null,
          infrastructureManifestId: evidence.manifestId, releaseManifestId: null,
        },
        routing: { lane: "infrastructure", operation: "apply", queue: "deployguard-infrastructure-v1" },
        idempotency: { canonicalKey, payloadSha256: "0".repeat(64), attempt: 1, replayOfJobId: null },
        execution: {
          mode: "full", resumeFromStage: null, reusableCheckpointIds: [],
          invalidatedCheckpointIds: [], reasonCodes: ["INFRASTRUCTURE_APPLY_DELIVERY_RECOVERY"],
          fencingTokenRequired: true,
        },
        trace: { correlationId: intentId, causationId: evidence.childId, actorUserId: evidence.userId },
        expiresAt: new Date(now.getTime() + 86_400_000).toISOString(),
      };
      envelope.idempotency.payloadSha256 = canonicalSha256(workerEnvelopePayloadForHash(envelope));
      const validated = validateWorkerEnvelopeV1(envelope, new Date(now.getTime() - 1));
      await manager.query(
        `INSERT INTO orchestration_outbox
           (intent_id, aggregate_type, aggregate_id, event_type, worker_envelope,
            payload_sha256, status, attempt_count, available_at, claim_fencing_token,
            created_at, updated_at)
         VALUES ($1, 'deployment_intent', $1, 'intent.infrastructure.apply',
                 $2::jsonb, $3, 'pending', 0, $4, 0, $4, $4)
         ON CONFLICT (intent_id, event_type, payload_sha256) DO NOTHING`,
        [intentId, JSON.stringify(validated), validated.idempotency.payloadSha256, now],
      );
      const outbox = await manager.query(
        `SELECT id FROM orchestration_outbox
          WHERE intent_id = $1 AND event_type = 'intent.infrastructure.apply'
            AND status = 'pending' AND attempt_count = 0 AND claimed_by IS NULL
            AND published_at IS NULL
          FOR UPDATE`,
        [intentId],
      );
      if (outbox.length !== 1) throw new Error("INFRASTRUCTURE_APPLY_DELIVERY_RECOVERY_CONFLICT");
      return { applyIntentId: intentId, applyOutboxId: outbox[0].id, replayed: false, recoveryMode: mode };
    });
  }

  private recoveryMode(evidence: any, effects: any[]): RecoveryMode | null {
    if (!evidence || evidence.childStatus !== "failed") return null;
    if (evidence.childFailure === "INFRASTRUCTURE_APPLY_CONTEXT_INVALID" && effects.length === 0) {
      return "context_invalid";
    }
    const priorId = evidence.childPayload?.recoveryOfApplyIntentId;
    if (evidence.childFailure === "PLACEHOLDER_HANDLER_THROWN"
      && typeof priorId === "string"
      && /^[0-9a-f-]{36}$/i.test(priorId)
      && evidence.childPayload?.recoveryMode === "reconciled_preflight"
      && effects.length === 0) {
      return "reconciled_preflight_no_effect";
    }
    if (evidence.childFailure === "PLACEHOLDER_HANDLER_THROWN"
      && typeof priorId === "string"
      && /^[0-9a-f-]{36}$/i.test(priorId)
      && effects.length === 1
      && effects[0].status === "uncertain"
      && effects[0].failureCode === "TERRAFORM_APPLY_OUTCOME_UNCERTAIN"
      && effects[0].reconciliationRequired === true) {
      return "reconciled_preflight";
    }
    return null;
  }

  private hash(value: unknown): value is string {
    return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
  }
}

function deterministicUuid(seed: string) {
  const hash = createHash("sha256").update(seed).digest("hex");
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}
