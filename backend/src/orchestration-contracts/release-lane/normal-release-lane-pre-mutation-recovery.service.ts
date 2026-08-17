import { ForbiddenException, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { normalV1AllowsScope } from "./normal-v1-activation-policy";
import { DescribeImagesCommand, ECRClient } from "@aws-sdk/client-ecr";
import { DataSource } from "typeorm";
import { User, UserRole } from "../../users/user.entity";
import { canonicalSha256 } from "../contracts/canonical-json";
import { PlannerClassificationNotAllowedError, PlannerIdempotencyConflictError } from "../planner/transactional-deployment-planner.types";
import { TransactionalDeploymentPlannerService } from "../planner/transactional-deployment-planner.service";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const COMMIT = /^[0-9a-f]{40}$/i;

type RecoveryRow = {
  failedIntentId: string;
  projectId: string;
  ownerUserId: number;
  environmentName: string;
  commitSha: string;
  candidateId: string;
  infrastructureId: string;
  infrastructureRevision: string;
  infrastructureOutputsHash: string;
  initialReleaseDraftId: string;
  initialReleaseDraftHash: string;
  stableId: string | null;
  repositoryName: string;
  region: string;
};

export type NormalReleaseLanePreMutationRecovery =
  | { state: "disabled"; safeCodes: readonly ["NORMAL_RELEASE_LANE_RECOVERY_DISABLED"] }
  | { state: "blocked"; safeCodes: readonly string[] }
  | { state: "prepared"; safeCodes: readonly ["NORMAL_RELEASE_LANE_RECOVERY_PREPARED"]; intent: { id: string; releaseManifestId: string | null; replayed: boolean } };

/**
 * Replaces only a terminal release that has proven it never reached immutable
 * image provenance or a downstream ECS mutation. It never mutates the failed
 * history; the planner writes a new intent/candidate/outbox atomically.
 */
@Injectable()
export class NormalReleaseLanePreMutationRecoveryService {
  constructor(
    private readonly config: ConfigService,
    private readonly dataSource: DataSource,
    private readonly planner: TransactionalDeploymentPlannerService,
  ) {}

  async recover(user: User, projectId: string, failedIntentId: string): Promise<NormalReleaseLanePreMutationRecovery> {
    const gate = this.gate(projectId);
    if (gate === "disabled") return { state: "disabled", safeCodes: ["NORMAL_RELEASE_LANE_RECOVERY_DISABLED"] };
    if (gate === "blocked" || !UUID.test(failedIntentId)) return this.blocked("NORMAL_RELEASE_LANE_RECOVERY_CONFIGURATION_INVALID");
    if (user.role !== UserRole.ADMIN && user.role !== UserRole.DEVELOPER) return this.blocked("NORMAL_RELEASE_LANE_ACTOR_NOT_ALLOWED");

    const row = await this.load(failedIntentId, projectId);
    if (!row) return this.blocked("NORMAL_RELEASE_LANE_PRE_MUTATION_RECOVERY_NOT_ELIGIBLE");
    if (user.role !== UserRole.ADMIN && user.id !== row.ownerUserId) {
      throw new ForbiddenException("You do not have permission to recover this project.");
    }
    if (!(await this.confirmAbsentImage(row))) return this.blocked("NORMAL_RELEASE_LANE_IMAGE_ABSENCE_UNPROVEN");

    const evidenceHash = canonicalSha256({
      schemaVersion: 1,
      policy: "normal-release-pre-mutation-recovery-v2",
      failedIntentId: row.failedIntentId,
      projectId: row.projectId,
      environmentName: row.environmentName,
      candidateId: row.candidateId,
      infrastructureId: row.infrastructureId,
      infrastructureRevision: row.infrastructureRevision,
      infrastructureOutputsHash: row.infrastructureOutputsHash,
      initialReleaseDraftId: row.initialReleaseDraftId,
      initialReleaseDraftHash: row.initialReleaseDraftHash,
      stableId: row.stableId,
      commitSha: row.commitSha,
      immutableImageState: "absent",
    });
    try {
      const planned = await this.planner.plan({
        actor: { userId: user.id, role: user.role === UserRole.ADMIN ? "admin" : "developer" },
        projectId: row.projectId,
        environmentName: "dev",
        kind: "deploy",
        idempotencyKey: `normal-release-recovery:v2:${row.failedIntentId}:${evidenceHash}`,
        requestedCommitSha: row.commitSha,
        recoveryCode: "PRE_MUTATION_IMAGE_ABSENT",
        preMutationRecovery: { failedIntentId: row.failedIntentId, evidenceHash },
        initialReleaseDraftId: row.initialReleaseDraftId,
        requiredClassification: "release_only",
      });
      if (!planned.intent.releaseManifestId
        || !(await this.ensureRecoveredFirstReleaseCandidate(
          planned.intent.id,
          planned.intent.releaseManifestId,
          row,
        ))) {
        return this.blocked("NORMAL_RELEASE_LANE_RECOVERY_CANDIDATE_INVALID");
      }
      return {
        state: "prepared",
        safeCodes: ["NORMAL_RELEASE_LANE_RECOVERY_PREPARED"],
        intent: { id: planned.intent.id, releaseManifestId: planned.intent.releaseManifestId, replayed: planned.replayed },
      };
    } catch (error) {
      if (error instanceof PlannerIdempotencyConflictError) return this.blocked("NORMAL_RELEASE_LANE_RECOVERY_IDEMPOTENCY_CONFLICT");
      if (error instanceof PlannerClassificationNotAllowedError) return this.blocked("NORMAL_RELEASE_LANE_RECOVERY_NOT_RELEASE_ONLY");
      return this.blocked("NORMAL_RELEASE_LANE_PRE_MUTATION_RECOVERY_NOT_ELIGIBLE");
    }
  }

  private async ensureRecoveredFirstReleaseCandidate(
    intentId: string,
    releaseManifestId: string,
    row: RecoveryRow,
  ) {
    return this.dataSource.transaction("SERIALIZABLE", async (manager) => {
      await manager.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        `deployguard:planner:${row.projectId}:${row.environmentName}`,
      ]);
      const records = await manager.query(
        `SELECT recovery.id, recovery.release_manifest_id AS "releaseManifestId",
                release.created_by_intent_id AS "createdByIntentId"
         FROM deployment_intents recovery
         JOIN release_manifests release ON release.id=recovery.release_manifest_id
         JOIN deployment_intents failed ON failed.id=$3
         JOIN orchestration_outbox outbox ON outbox.intent_id=recovery.id
         WHERE recovery.id=$1 AND recovery.project_id=$4 AND recovery.environment_name='dev'
           AND recovery.status='planned' AND recovery.classification='release_only'
           AND recovery.request_payload->>'recoveryOfIntentId'=failed.id::text
           AND recovery.request_payload->>'initialReleaseDraftId'=$5
           AND recovery.release_manifest_id=$2
           AND release.status='desired' AND release.image_digest IS NULL
           AND release.task_definition_arn IS NULL AND release.initial_service_arn IS NULL
           AND release.infrastructure_manifest_id=$6
           AND release.commit_sha=$7
           AND release.created_by_intent_id IN (recovery.id,failed.id)
           AND outbox.status='pending' AND outbox.attempt_count=0
           AND outbox.published_at IS NULL AND outbox.published_job_id IS NULL
           AND outbox.claimed_by IS NULL AND outbox.claim_expires_at IS NULL
         FOR UPDATE OF recovery,release,failed,outbox`,
        [intentId, releaseManifestId, row.failedIntentId, row.projectId,
          row.initialReleaseDraftId, row.infrastructureId, row.commitSha],
      ) as Array<{ createdByIntentId: string }>;
      if (records.length !== 1) return false;
      if (records[0].createdByIntentId === intentId) return true;
      const updated = await manager.query(
        `UPDATE release_manifests SET created_by_intent_id=$1, updated_at=clock_timestamp()
         WHERE id=$2 AND created_by_intent_id=$3 AND status='desired'
           AND image_digest IS NULL AND task_definition_arn IS NULL
           AND initial_service_arn IS NULL RETURNING id`,
        [intentId, releaseManifestId, row.failedIntentId],
      );
      const updatedRows = Array.isArray(updated?.[0]) ? updated[0] : updated;
      return updatedRows.length === 1;
    });
  }

  private async load(failedIntentId: string, projectId: string): Promise<RecoveryRow | null> {
    const rows = await this.dataSource.query(
      `SELECT failed.id AS "failedIntentId", failed.project_id AS "projectId",
              project.owner_user_id AS "ownerUserId", failed.environment_name AS "environmentName",
              candidate.commit_sha AS "commitSha", candidate.id AS "candidateId",
              infrastructure.id AS "infrastructureId",
              infrastructure.revision::text AS "infrastructureRevision",
              infrastructure.terraform_outputs_hash AS "infrastructureOutputsHash",
              draft.id AS "initialReleaseDraftId", draft.draft_hash AS "initialReleaseDraftHash",
              stable.id AS "stableId",
              infrastructure.terraform_outputs->>'ecr_repository_name' AS "repositoryName",
              infrastructure.desired_spec->>'region' AS region
       FROM deployment_intents failed
       JOIN projects project ON project.id = failed.project_id
       JOIN release_manifests candidate ON candidate.id = failed.release_manifest_id
       JOIN infrastructure_manifests infrastructure ON infrastructure.id = failed.infrastructure_manifest_id
       JOIN initial_release_drafts draft
         ON draft.id=(failed.request_payload->>'initialReleaseDraftId')::uuid
        AND draft.project_id=failed.project_id
        AND draft.environment_name=failed.environment_name
        AND draft.infrastructure_manifest_id=infrastructure.id
       LEFT JOIN release_manifests stable ON stable.id = candidate.previous_stable_manifest_id
       JOIN orchestration_outbox outbox ON outbox.intent_id = failed.id
       WHERE failed.id = $1 AND failed.project_id = $2 AND failed.environment_name = 'dev'
         AND failed.kind = 'deploy' AND failed.classification = 'release_only'
         AND failed.status = 'failed' AND failed.failure_code = 'INVOCATION_PREPARATION_FAILED'
         AND candidate.status = 'desired' AND candidate.image_digest IS NULL
         AND candidate.task_definition_arn IS NULL AND candidate.initial_service_arn IS NULL
         AND (candidate.previous_stable_manifest_id IS NULL OR stable.status = 'stable')
         AND infrastructure.status = 'applied'
         AND infrastructure.terraform_outputs_hash ~ '^[0-9a-f]{64}$'
         AND draft.release_draft->>'commitSha'=candidate.commit_sha
         AND outbox.status = 'published' AND outbox.attempt_count = 1 AND outbox.published_at IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM release_image_provenances provenance WHERE provenance.intent_id = failed.id)
         AND 1 = (SELECT count(*) FROM deployment_side_effects effect WHERE effect.intent_id = failed.id
                    AND effect.effect_type = 'ecr.build_push_immutable_image' AND (
                      (effect.status = 'uncertain' AND effect.reconciliation_required = true AND effect.failure_code = 'SIDE_EFFECT_OUTCOME_UNKNOWN')
                      OR (effect.status = 'failed' AND effect.reconciliation_required = false AND effect.failure_code IN (
                        'FIRST_RELEASE_BUILD_CONTRACT_INVALID','FIRST_RELEASE_DOCKERFILE_CONTEXT_UNAVAILABLE',
                        'FIRST_RELEASE_DOCKERFILE_UNAVAILABLE','FIRST_RELEASE_SOURCE_PIN_MISMATCH',
                        'FIRST_RELEASE_APP_ROOT_INVALID','FIRST_RELEASE_DOCKER_BUILD_FAILED',
                        'FIRST_RELEASE_ECR_LOGIN_FAILED','FIRST_RELEASE_DOCKER_TAG_FAILED'
                      ))
                    ))
         AND NOT EXISTS (SELECT 1 FROM deployment_side_effects effect WHERE effect.intent_id = failed.id
                           AND effect.effect_type <> 'ecr.build_push_immutable_image')`,
      [failedIntentId, projectId],
    ) as RecoveryRow[];
    const row = rows.length === 1 ? rows[0] : null;
    return row && COMMIT.test(row.commitSha) && typeof row.repositoryName === "string" && typeof row.region === "string"
      ? row : null;
  }

  private async confirmAbsentImage(row: RecoveryRow) {
    try {
      const client = new ECRClient({ region: row.region });
      const response = await client.send(new DescribeImagesCommand({
        repositoryName: row.repositoryName,
        imageIds: [{ imageTag: row.commitSha }],
      }));
      return response.imageDetails?.length === 0;
    } catch (error) {
      return typeof error === "object" && error !== null
        && (error as { name?: unknown }).name === "ImageNotFoundException";
    }
  }

  private gate(projectId: string): "ready" | "disabled" | "blocked" {
    if (this.config.get<unknown>("TWO_LANE_NORMAL_RELEASE_PLANNING_ENABLED") !== "true"
      || this.config.get<unknown>("TWO_LANE_NORMAL_RELEASE_RECOVERY_ENABLED") !== "true") return "disabled";
    return normalV1AllowsScope(this.config, projectId, "dev")
      ? "ready" : "blocked";
  }

  private blocked(code: string): NormalReleaseLanePreMutationRecovery {
    return { state: "blocked", safeCodes: [code] };
  }
}
