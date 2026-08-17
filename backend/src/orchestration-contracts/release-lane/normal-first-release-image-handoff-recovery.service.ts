import { createHash } from "node:crypto";
import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { DescribeImagesCommand, ECRClient } from "@aws-sdk/client-ecr";
import { DataSource, EntityManager } from "typeorm";
import { canonicalSha256 } from "../contracts/canonical-json";
import { validateWorkerEnvelopeV1, workerEnvelopeJobId } from "../contracts/worker-envelope.validator";
import { FrozenProtocolQueue } from "../outbox/frozen-bullmq-job.adapter";
import { createRedisConnection } from "../../projects/pipeline/redis.config";
import { deriveV1FirstReleaseEffectKey } from "../worker-runtime/inactive-v1-first-release-bootstrap.pure";
import { InactiveV1SideEffectReconciliationCoordinatorService } from "../worker-runtime/inactive-v1-side-effect-reconciliation-coordinator.service";
import { InactiveReleaseLaneOwnershipService } from "./inactive-release-lane-ownership.service";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const SHA = /^[0-9a-f]{64}$/;
const RECOVERABLE_FAILURES = new Set([
  "SIDE_EFFECT_RECONCILIATION_REQUIRED",
  "FIRST_RELEASE_MANIFEST_CONFLICT",
  "FIRST_RELEASE_INFRASTRUCTURE_OUTPUT_INVALID",
  "FIRST_RELEASE_NORMAL_CONTEXT_INVALID",
]);

type RecoveryEvidence = {
  projectId: string;
  intentId: string;
  status: string;
  failureCode: string | null;
  canonicalIdempotencyKey: string;
  releaseManifestId: string;
  releaseStatus: string;
  commitSha: string;
  buildFingerprint: string;
  imageUri: string;
  imageDigest: string;
  taskDefinitionArn: string | null;
  initialServiceArn: string | null;
  infrastructureManifestId: string;
  infrastructureRevision: string;
  repositoryName: string;
  repositoryUrl: string;
  region: string;
  draftId: string;
  draftHash: string;
  publishedJobId: string;
  outboxId: string;
};

type EffectEvidence = {
  id: string;
  operationId: string;
  idempotencyKey: string;
  requestFingerprint: string;
  status: string;
  effectType: string;
};

type ProvenanceEvidence = {
  id: string;
  operationId: string;
  idempotencyKey: string;
  imageUri: string;
  imageDigest: string;
  evidenceFingerprint: string;
};

/**
 * Exact recovery for the one historical composition defect where the
 * later-release preparation hook pushed an initial-release image before the
 * canonical first-release bootstrap observed it. It never publishes a new
 * outbox or invokes a mutation; it reconciles ECR read-only and resumes the
 * same frozen job.
 */
@Injectable()
export class NormalFirstReleaseImageHandoffRecoveryService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly config: ConfigService,
    private readonly ownership: InactiveReleaseLaneOwnershipService,
    private readonly reconciliation:
      InactiveV1SideEffectReconciliationCoordinatorService,
  ) {}

  async recoverExact(projectId: string, intentId: string) {
    this.assertEnabled(projectId, intentId);
    const evidence = await this.loadEvidence(projectId, intentId);
    const queue = new FrozenProtocolQueue("deployguard-release-v1", {
      connection: createRedisConnection(this.config),
      prefix: this.config.get<string>("OUTBOX_BULLMQ_PREFIX", "bull"),
    });
    const session = this.dataSource.createQueryRunner();
    const lockKey = `deployguard:first-release-image-handoff:${projectId}:dev`;
    await session.connect();
    await session.query("SELECT pg_advisory_lock(hashtext($1))", [lockKey]);
    try {
      const job = await queue.getJob(evidence.publishedJobId);
      const envelope = job ? validateWorkerEnvelopeV1(job.data) : null;
      const jobState = job ? await job.getState() : null;
      if (
        !job
        || !envelope
        || workerEnvelopeJobId(envelope) !== evidence.publishedJobId
        || envelope.identity.projectId !== projectId
        || envelope.identity.intentId !== intentId
        || envelope.identity.releaseManifestId !== evidence.releaseManifestId
        || !["failed", "waiting", "active"].includes(jobState ?? "")
        || (jobState === "failed"
          && !RECOVERABLE_FAILURES.has(job.failedReason ?? ""))
      ) {
        throw new Error("FIRST_RELEASE_IMAGE_HANDOFF_JOB_INVALID");
      }

      const root = canonicalSha256({
        intentId,
        key: evidence.canonicalIdempotencyKey,
        draftHash: evidence.draftHash,
      });
      const expectedOperationId = this.operationId(root, "push-image");
      const effects = await this.loadEffects(intentId);
      const canonical = effects.find((row) =>
        row.operationId === expectedOperationId
        && row.effectType === "ecr.build_push_immutable_image"
      );
      const provenance = await this.loadProvenance(intentId);
      const preparation = provenance.operationId === expectedOperationId
        ? effects.find((row) =>
          row.operationId !== expectedOperationId
          && row.effectType === "ecr.build_push_immutable_image"
        )
        : effects.find((row) =>
          row.operationId === provenance.operationId
          && row.effectType === "ecr.build_push_immutable_image"
        );
      if (
        effects.length !== 2
        || !canonical
        || !preparation
        || preparation.id === canonical.id
        || preparation.status !== "succeeded"
        || !["uncertain", "succeeded"].includes(canonical.status)
        || provenance.imageUri !== evidence.imageUri
        || provenance.imageDigest !== evidence.imageDigest
        || !DIGEST.test(provenance.imageDigest)
        || !SHA.test(provenance.evidenceFingerprint)
        || evidence.taskDefinitionArn !== null
        || evidence.initialServiceArn !== null
      ) {
        throw new Error("FIRST_RELEASE_IMAGE_HANDOFF_EVIDENCE_INVALID");
      }

      const fenceKey = canonicalSha256({
        schemaVersion: 1,
        policy: "normal-first-release-image-handoff-recovery-v1",
        projectId,
        intentId,
        operationId: canonical.operationId,
        imageDigest: provenance.imageDigest,
      });
      const leaseId = this.uuidFromHash(fenceKey);
      const actorId = "normal-first-release-image-handoff-recovery";
      const acquired = await this.ownership.acquire({
        projectId,
        environmentName: "dev",
        lane: "v1",
        leaseId,
        actorId,
        idempotencyKey: fenceKey,
        requestFingerprint: fenceKey,
        leaseTtlMs: 60_000,
        ownV1IntentId: intentId,
      });
      if (!["acquired", "already_owned"].includes(acquired.disposition)) {
        throw new Error("FIRST_RELEASE_IMAGE_HANDOFF_OWNERSHIP_BLOCKED");
      }
      const owned = (acquired as Extract<typeof acquired, { ownership: unknown }>).ownership;
      try {
        if (canonical.status === "uncertain") {
          await this.reconcileImage(evidence, canonical, provenance);
        }
        await this.resumeUnderFence(
          evidence,
          canonical,
          preparation,
          provenance,
          leaseId,
          actorId,
          owned.fencingToken,
        );
      } finally {
        await this.ownership.release({
          projectId,
          environmentName: "dev",
          lane: "v1",
          leaseId,
          actorId,
          fencingToken: owned.fencingToken,
        }).catch(() => undefined);
      }

      const currentState = await job.getState();
      if (currentState === "failed") await job.retry("failed");
      return {
        state: "resumed" as const,
        safeCode: "FIRST_RELEASE_IMAGE_HANDOFF_RECONCILED",
        deterministicJobId: evidence.publishedJobId,
        replayed: currentState !== "failed",
      };
    } finally {
      await session.query("SELECT pg_advisory_unlock(hashtext($1))", [lockKey])
        .catch(() => undefined);
      await session.release().catch(() => undefined);
      await queue.close();
    }
  }

  private assertEnabled(projectId: string, intentId: string) {
    if (
      this.config.get<unknown>(
        "TWO_LANE_NORMAL_FIRST_RELEASE_IMAGE_HANDOFF_RECOVERY_ENABLED",
      ) !== "true"
      || !UUID.test(projectId)
      || !UUID.test(intentId)
      || this.config.get<unknown>("TWO_LANE_RELEASE_PROJECT_ALLOWLIST")
        !== projectId
      || this.config.get<unknown>("TWO_LANE_RELEASE_ENVIRONMENT_ALLOWLIST")
        !== "dev"
    ) {
      throw new Error("FIRST_RELEASE_IMAGE_HANDOFF_RECOVERY_DISABLED");
    }
  }

  private async reconcileImage(
    evidence: RecoveryEvidence,
    canonical: EffectEvidence,
    provenance: ProvenanceEvidence,
  ) {
    const inspectionFingerprint = canonicalSha256({
      schemaVersion: 1,
      policy: "normal-first-release-image-handoff-inspection-v1",
      sideEffectId: canonical.id,
      imageDigest: provenance.imageDigest,
      commitSha: evidence.commitSha,
      infrastructureManifestId: evidence.infrastructureManifestId,
    });
    const ecr = new ECRClient({ region: evidence.region });
    const result = await this.reconciliation.coordinate({
      workerId: "normal-first-release-image-handoff-reconcile",
      leaseTtlMs: 60_000,
      request: {
        sideEffectId: canonical.id,
        operationId: this.uuidFromHash(canonicalSha256({
          schemaVersion: 1,
          sideEffectId: canonical.id,
          operation: "reconcile-existing-image",
        })),
        idempotencyKey: canonicalSha256({
          schemaVersion: 1,
          sideEffectId: canonical.id,
          imageDigest: provenance.imageDigest,
        }),
        inspectionFingerprint,
        timeoutMs: 30_000,
        adapter: {
          policy: "deployguard.side-effect-reconciliation/read-only-v1",
          adapterId: "deployguard.normal-first-release-image-handoff.v1",
          effectType: "ecr.build_push_immutable_image",
          inspect: async (context) => {
            if (
              !context.readOnly
              || context.signal.aborted
              || !context.isLeaseTrusted()
            ) throw new Error("FIRST_RELEASE_IMAGE_HANDOFF_OWNERSHIP_LOST");
            const response = await ecr.send(new DescribeImagesCommand({
              repositoryName: evidence.repositoryName,
              imageIds: [{ imageTag: evidence.commitSha }],
            }), { abortSignal: context.signal });
            const images = response.imageDetails ?? [];
            if (
              images.length !== 1
              || images[0].imageDigest !== provenance.imageDigest
            ) {
              return {
                classification: "manual_review" as const,
                safeFailureCode:
                  "FIRST_RELEASE_IMAGE_HANDOFF_DIGEST_CONFLICT",
                evidenceFingerprint: inspectionFingerprint,
              };
            }
            return {
              classification: "succeeded" as const,
              safeEvidenceCode: "FIRST_RELEASE_IMAGE_DIGEST_VERIFIED",
              evidenceFingerprint: inspectionFingerprint,
              resultFingerprint: provenance.evidenceFingerprint,
              externalReferenceHash: canonicalSha256({
                imageUri: provenance.imageUri,
                imageDigest: provenance.imageDigest,
              }),
            };
          },
        },
      },
    });
    const classification = result.disposition === "coordinated"
      && (
        result.result.disposition === "classified"
        || result.result.disposition === "replayed"
      )
      ? result.result.classification
      : result.disposition === "terminal_evidence_replayed"
        ? result.classification
        : null;
    if (classification !== "succeeded") {
      throw new Error("FIRST_RELEASE_IMAGE_HANDOFF_RECONCILIATION_REQUIRED");
    }
  }

  private async resumeUnderFence(
    evidence: RecoveryEvidence,
    canonical: EffectEvidence,
    preparation: EffectEvidence,
    provenance: ProvenanceEvidence,
    leaseId: string,
    actorId: string,
    fencingToken: string,
  ) {
    await this.dataSource.transaction("SERIALIZABLE", async (manager) => {
      // recoverExact() already holds this scope's session advisory lock.
      // Reacquiring the same lock through the transaction's separate
      // connection would self-deadlock.
      const fence = this.rows(await manager.query(
        `SELECT 1 FROM project_release_lane_ownerships
         WHERE project_id=$1 AND environment_name='dev' AND owner_lane='v1'
           AND lease_id=$2 AND actor_id=$3 AND fencing_token=$4::bigint
           AND status IN ('acquired','heartbeat_active')
           AND expires_at > clock_timestamp() FOR UPDATE`,
        [evidence.projectId, leaseId, actorId, fencingToken],
      ));
      if (fence.length !== 1) {
        throw new Error("FIRST_RELEASE_IMAGE_HANDOFF_FENCE_LOST");
      }
      const fresh = await this.loadEvidence(
        evidence.projectId,
        evidence.intentId,
        manager,
      );
      const effects = await this.loadEffects(evidence.intentId, manager);
      const currentCanonical = effects.find((row) =>
        row.operationId === canonical.operationId
      );
      const currentPreparation = effects.find((row) =>
        row.operationId === preparation.operationId
      );
      const currentProvenance = await this.loadProvenance(
        evidence.intentId,
        manager,
      );
      if (
        fresh.releaseManifestId !== evidence.releaseManifestId
        || fresh.draftId !== evidence.draftId
        || fresh.draftHash !== evidence.draftHash
        || fresh.infrastructureManifestId
          !== evidence.infrastructureManifestId
        || currentCanonical?.status !== "succeeded"
        || currentPreparation?.status !== "succeeded"
        || currentProvenance.id !== provenance.id
        || currentProvenance.imageDigest !== provenance.imageDigest
        || !["failed", "enqueued"].includes(fresh.status)
        || (fresh.status === "failed"
          && !RECOVERABLE_FAILURES.has(fresh.failureCode ?? ""))
      ) {
        throw new Error("FIRST_RELEASE_IMAGE_HANDOFF_EVIDENCE_CHANGED");
      }
      const expectedProvenanceKey = deriveV1FirstReleaseEffectKey(
        canonicalSha256({
          intentId: evidence.intentId,
          key: evidence.canonicalIdempotencyKey,
          draftHash: evidence.draftHash,
        }),
        "push_image",
        canonical.operationId,
      );
      if (currentProvenance.operationId !== canonical.operationId) {
        const rebound = this.rows(await manager.query(
          `UPDATE release_image_provenances
           SET operation_id=$2, idempotency_key=$3
           WHERE id=$1 AND intent_id=$4 AND operation_id=$5
             AND image_digest=$6
           RETURNING id`,
          [
            currentProvenance.id,
            canonical.operationId,
            expectedProvenanceKey,
            evidence.intentId,
            preparation.operationId,
            provenance.imageDigest,
          ],
        ));
        if (rebound.length !== 1) {
          throw new Error("FIRST_RELEASE_IMAGE_HANDOFF_REBIND_CONFLICT");
        }
      } else if (currentProvenance.idempotencyKey !== expectedProvenanceKey) {
        throw new Error("FIRST_RELEASE_IMAGE_HANDOFF_PROVENANCE_CONFLICT");
      }
      if (fresh.status === "failed") {
        const resumed = this.rows(await manager.query(
          `UPDATE deployment_intents
           SET status='enqueued', completed_at=NULL, failure_code=NULL,
               failure_message=NULL, updated_at=clock_timestamp()
           WHERE id=$1 AND status='failed'
             AND failure_code = ANY($2::varchar[])
           RETURNING id`,
          [evidence.intentId, [...RECOVERABLE_FAILURES]],
        ));
        if (resumed.length !== 1) {
          throw new Error("FIRST_RELEASE_IMAGE_HANDOFF_RESUME_CONFLICT");
        }
      }
      await manager.query(
        `INSERT INTO audit_logs (
           actor_user_id, action, category, resource_type, resource_id,
           status, metadata
         )
         SELECT intent.requested_by_user_id,
                'normal_first_release.resume_after_image_handoff',
                'release', 'deployment_intent', intent.id::text, 'resumed',
                jsonb_build_object(
                  'safeCode', 'FIRST_RELEASE_IMAGE_HANDOFF_RECONCILED',
                  'environment', 'dev'
                )
         FROM deployment_intents intent WHERE intent.id=$1
         AND NOT EXISTS (
           SELECT 1 FROM audit_logs
           WHERE action='normal_first_release.resume_after_image_handoff'
             AND resource_type='deployment_intent'
             AND resource_id=$1::text
         )`,
        [evidence.intentId],
      );
    });
  }

  private async loadEvidence(
    projectId: string,
    intentId: string,
    executor: DataSource | EntityManager = this.dataSource,
  ) {
    const rows = this.rows<RecoveryEvidence>(await executor.query(
      `SELECT intent.project_id AS "projectId", intent.id AS "intentId",
              intent.status, intent.failure_code AS "failureCode",
              intent.canonical_idempotency_key AS "canonicalIdempotencyKey",
              release.id AS "releaseManifestId", release.status AS "releaseStatus",
              release.commit_sha AS "commitSha",
              release.build_fingerprint AS "buildFingerprint",
              release.image_uri AS "imageUri",
              release.image_digest AS "imageDigest",
              release.task_definition_arn AS "taskDefinitionArn",
              release.initial_service_arn AS "initialServiceArn",
              infrastructure.id AS "infrastructureManifestId",
              infrastructure.revision::text AS "infrastructureRevision",
              infrastructure.terraform_outputs->>'ecr_repository_name'
                AS "repositoryName",
              infrastructure.terraform_outputs->>'ecr_repository_url'
                AS "repositoryUrl",
              infrastructure.desired_spec->>'region' AS region,
              draft.id AS "draftId", draft.draft_hash AS "draftHash",
              outbox.id AS "outboxId",
              outbox.published_job_id AS "publishedJobId"
       FROM deployment_intents intent
       JOIN release_manifests release
         ON release.id=intent.release_manifest_id
       JOIN infrastructure_manifests infrastructure
         ON infrastructure.id=intent.infrastructure_manifest_id
       JOIN initial_release_drafts draft
         ON draft.id=(intent.request_payload->>'initialReleaseDraftId')::uuid
       JOIN orchestration_outbox outbox ON outbox.intent_id=intent.id
       WHERE intent.id=$1 AND intent.project_id=$2
         AND intent.environment_name='dev'
         AND intent.kind='deploy' AND intent.classification='release_only'
         AND intent.status IN ('failed','enqueued')
         AND (intent.status='enqueued'
           OR intent.failure_code = ANY($3::varchar[]))
         AND release.created_by_intent_id=intent.id
         AND release.previous_stable_manifest_id IS NULL
         AND release.parent_manifest_id IS NULL
         AND release.status IN ('built','building')
         AND infrastructure.status='applied'
         AND draft.infrastructure_manifest_id=infrastructure.id
         AND draft.draft_hash ~ '^[0-9a-f]{64}$'
         AND release.commit_sha=draft.release_draft->>'commitSha'
         AND outbox.status='published' AND outbox.attempt_count=1
         AND outbox.claimed_by IS NULL
         AND outbox.claim_expires_at IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM project_operation_leases lease
           WHERE lease.intent_id=intent.id
             AND lease.status IN ('acquired','heartbeat_active')
             AND lease.expires_at > clock_timestamp()
         )`,
      [intentId, projectId, [...RECOVERABLE_FAILURES]],
    ));
    if (
      rows.length !== 1
      || !UUID.test(rows[0].draftId)
      || !UUID.test(rows[0].infrastructureManifestId)
      || !/^[0-9a-f]{40}$/.test(rows[0].commitSha)
      || !SHA.test(rows[0].buildFingerprint)
      || !DIGEST.test(rows[0].imageDigest)
      || !rows[0].repositoryName
      || !rows[0].repositoryUrl
      || !rows[0].region
    ) {
      throw new Error("FIRST_RELEASE_IMAGE_HANDOFF_EVIDENCE_INVALID");
    }
    return rows[0];
  }

  private async loadEffects(
    intentId: string,
    executor: DataSource | EntityManager = this.dataSource,
  ) {
    return this.rows<EffectEvidence>(await executor.query(
      `SELECT id, operation_id AS "operationId",
              idempotency_key AS "idempotencyKey",
              request_fingerprint AS "requestFingerprint",
              status, effect_type AS "effectType"
       FROM deployment_side_effects
       WHERE intent_id=$1 ORDER BY created_at, id`,
      [intentId],
    ));
  }

  private async loadProvenance(
    intentId: string,
    executor: DataSource | EntityManager = this.dataSource,
  ) {
    const rows = this.rows<ProvenanceEvidence>(await executor.query(
      `SELECT id, operation_id AS "operationId",
              idempotency_key AS "idempotencyKey",
              image_uri AS "imageUri", image_digest AS "imageDigest",
              evidence_fingerprint AS "evidenceFingerprint"
       FROM release_image_provenances WHERE intent_id=$1
       ORDER BY created_at, id`,
      [intentId],
    ));
    if (rows.length !== 1) {
      throw new Error("FIRST_RELEASE_IMAGE_HANDOFF_PROVENANCE_INVALID");
    }
    return rows[0];
  }

  private operationId(root: string, operation: string) {
    const hash = canonicalSha256({ schemaVersion: 1, root, operation });
    const variant = (parseInt(hash[16], 16) & 0x3) | 0x8;
    return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}`
      + `-${variant.toString(16)}${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
  }

  private uuidFromHash(hash: string) {
    const value = createHash("sha256").update(hash).digest("hex");
    return `${value.slice(0, 8)}-${value.slice(8, 12)}-5${value.slice(13, 16)}`
      + `-8${value.slice(17, 20)}-${value.slice(20, 32)}`;
  }

  private rows<T>(result: unknown): T[] {
    return Array.isArray(result) && Array.isArray(result[0])
      ? result[0] as T[]
      : Array.isArray(result)
        ? result as T[]
        : [];
  }
}
