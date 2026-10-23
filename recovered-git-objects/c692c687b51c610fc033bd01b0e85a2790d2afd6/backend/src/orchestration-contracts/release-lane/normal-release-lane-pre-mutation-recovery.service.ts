import { ForbiddenException, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
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
  stableId: string;
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
      policy: "normal-release-pre-mutation-recovery-v1",
      failedIntentId: row.failedIntentId,
      projectId: row.projectId,
      environmentName: row.environmentName,
      candidateId: row.candidateId,
      infrastructureId: row.infrastructureId,
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
        idempotencyKey: `normal-release-recovery:v1:${row.failedIntentId}:${evidenceHash}`,
        requestedCommitSha: row.commitSha,
        recoveryCode: "PRE_MUTATION_IMAGE_ABSENT",
        preMutationRecovery: { failedIntentId: row.failedIntentId, evidenceHash },
        requiredClassification: "release_only",
      });
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

  private async load(failedIntentId: string, projectId: string): Promise<RecoveryRow | null> {
    const rows = await this.dataSource.query(
      `SELECT failed.id AS "failedIntentId", failed.project_id AS "projectId",
              project.owner_user_id AS "ownerUserId", failed.environment_name AS "environmentName",
              candidate.commit_sha AS "commitSha", candidate.id AS "candidateId",
              infrastructure.id AS "infrastructureId", stable.id AS "stableId",
              infrastructure.terraform_outputs->>'ecr_repository_name' AS "repositoryName",
              infrastructure.desired_spec->>'region' AS region
       FROM deployment_intents failed
       JOIN projects project ON project.id = failed.project_id
       JOIN release_manifests candidate ON candidate.id = failed.release_manifest_id
       JOIN infrastructure_manifests infrastructure ON infrastructure.id = failed.infrastructure_manifest_id
       JOIN release_manifests stable ON stable.id = candidate.previous_stable_manifest_id
       JOIN orchestration_outbox outbox ON outbox.intent_id = failed.id
       WHERE failed.id = $1 AND failed.project_id = $2 AND failed.environment_name = 'dev'
         AND failed.kind = 'deploy' AND failed.classification = 'release_only'
         AND failed.status = 'failed' AND failed.failure_code = 'INVOCATION_PREPARATION_FAILED'
         AND candidate.status = 'desired' AND candidate.image_digest IS NULL
         AND candidate.task_definition_arn IS NULL AND candidate.initial_service_arn IS NULL
         AND stable.status = 'stable' AND infrastructure.status = 'applied'
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
    const projects = this.config.get<unknown>("TWO_LANE_RELEASE_PROJECT_ALLOWLIST");
    if (typeof projects !== "string") return "blocked";
    const allowlist = projects.split(",").map((value) => value.trim()).filter(Boolean);
    return allowlist.length === 1 && allowlist[0] === projectId && UUID.test(projectId)
      && this.config.get<unknown>("TWO_LANE_RELEASE_ENVIRONMENT_ALLOWLIST") === "dev" ? "ready" : "blocked";
  }

  private blocked(code: string): NormalReleaseLanePreMutationRecovery {
    return { state: "blocked", safeCodes: [code] };
  }
}
