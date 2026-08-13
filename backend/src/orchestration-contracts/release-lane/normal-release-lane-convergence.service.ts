import { Injectable, Optional } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { DescribeImagesCommand, ECRClient } from "@aws-sdk/client-ecr";
import { DescribeServicesCommand, ECSClient } from "@aws-sdk/client-ecs";
import { DataSource } from "typeorm";
import {
  validateWorkerEnvelopeV1,
  workerEnvelopeJobId,
} from "../contracts/worker-envelope.validator";
import { FrozenProtocolQueue } from "../outbox/frozen-bullmq-job.adapter";
import { createRedisConnection } from "../../projects/pipeline/redis.config";
import { resolveReleaseServiceArn } from "./release-service-lineage";
import {
  LocalV1ReleaseFixtureAdapterFactory,
} from "./local-v1-release-fixture-adapter.factory";
import { normalV1AllowsScope } from "./normal-v1-activation-policy";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DIGEST = /^sha256:[0-9a-f]{64}$/;

type ConvergenceEvidence = {
  intentId: string;
  projectId: string;
  actorId: number;
  candidateId: string;
  candidateDigest: string;
  candidateTaskDefinitionArn: string;
  infrastructureId: string;
  stableId: string;
  stablePreviousManifestId: string | null;
  clusterArn: string;
  serviceArn: string | null;
  ecrRepositoryName: string;
  publishedJobId: string;
  status: string;
  failureCode: string | null;
};

/** Bounds are supplied only by the default-off supervised scheduler. */
export type NormalReleaseLaneConvergenceBounds = Readonly<{
  maxAttempts: number;
  maxElapsedMs: number;
}>;

export type NormalReleaseLaneConvergenceResult = Readonly<{
  state: "blocked" | "resumed" | "exhausted";
  safeCodes: readonly [string];
}>;

/**
 * Exact, default-off recovery for a normal release whose three mutations are
 * durably succeeded but whose first rollout inspection was transiently
 * ambiguous. It retries the existing deterministic failed job only after
 * read-only identity convergence; it never publishes a new job.
 */
@Injectable()
export class NormalReleaseLaneConvergenceService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly config: ConfigService,
    @Optional()
    private readonly localFixture?: LocalV1ReleaseFixtureAdapterFactory,
  ) {}

  async reconcileExact(
    projectId: string,
    intentId: string,
    bounds?: NormalReleaseLaneConvergenceBounds,
  ): Promise<NormalReleaseLaneConvergenceResult> {
    if (
      this.config.get<unknown>(
        "TWO_LANE_NORMAL_RELEASE_OUTCOME_RECONCILE_APPROVED",
      ) !== "true"
      || !UUID.test(projectId)
      || !UUID.test(intentId)
      || !normalV1AllowsScope(this.config, projectId, "dev")
    ) {
      return this.result("blocked", "NORMAL_RELEASE_CONVERGENCE_DISABLED");
    }
    const evidence = await this.loadExact(projectId, intentId);
    if (!evidence) {
      return this.result(
        "blocked",
        "NORMAL_RELEASE_CONVERGENCE_EVIDENCE_INVALID",
      );
    }
    const queue = new FrozenProtocolQueue("deployguard-release-v1", {
      connection: createRedisConnection(this.config),
      prefix: this.config.get<string>("OUTBOX_BULLMQ_PREFIX", "bull"),
    });
    const retryLock = this.dataSource.createQueryRunner();
    try {
      await retryLock.connect();
      await retryLock.query("SELECT pg_advisory_lock(hashtext($1))", [
        `deployguard:normal-release-outcome-retry:${evidence.projectId}:dev:${evidence.intentId}`,
      ]);
      const job = await queue.getJob(evidence.publishedJobId);
      const envelope = job ? validateWorkerEnvelopeV1(job.data) : null;
      const jobState = job ? await job.getState() : null;
      if (
        !job
        || !envelope
        || workerEnvelopeJobId(envelope) !== evidence.publishedJobId
        || envelope.identity.intentId !== intentId
        || envelope.identity.projectId !== projectId
        || envelope.identity.releaseManifestId !== evidence.candidateId
        || (
          jobState !== "failed"
          && jobState !== "waiting"
          && jobState !== "active"
        )
      ) {
        return this.result(
          "blocked",
          "NORMAL_RELEASE_CONVERGENCE_JOB_INVALID",
        );
      }
      // A concurrent scheduler or the recovering process has already moved
      // this exact frozen job back into delivery. It is one logical retry, not
      // a second scheduling event.
      if (jobState === "waiting" || jobState === "active") {
        return this.result("resumed", "NORMAL_RELEASE_CONVERGENCE_RESUMED");
      }
      if (job.failedReason !== "RELEASE_EVIDENCE_AMBIGUOUS") {
        return this.result(
          "blocked",
          "NORMAL_RELEASE_CONVERGENCE_JOB_INVALID",
        );
      }
      if (bounds && !this.withinBounds(job, bounds)) {
        const exhausted = await this.markBoundExhausted(
          evidence,
          bounds,
        );
        return exhausted
          ? this.result("exhausted", "NORMAL_RELEASE_CONVERGENCE_BOUND_EXHAUSTED")
          : this.result("blocked", "NORMAL_RELEASE_CONVERGENCE_RESUME_REJECTED");
      }
      // A failed job never receives another delivery until its exact external
      // identity is re-proven. Bound exhaustion above deliberately precedes
      // this read so permanently inconclusive evidence cannot leave a timer
      // reconciling forever.
      if (!(await this.readOnlyIdentityConverged(evidence))) {
        return this.result(
          "blocked",
          "NORMAL_RELEASE_CONVERGENCE_NOT_PROVEN",
        );
      }
      if (!(await this.resume(evidence))) {
        return this.result(
          "blocked",
          "NORMAL_RELEASE_CONVERGENCE_RESUME_REJECTED",
        );
      }
      await job.retry("failed");
      return this.result("resumed", "NORMAL_RELEASE_CONVERGENCE_RESUMED");
    } finally {
      if (retryLock.isReleased === false) {
        await retryLock.query("SELECT pg_advisory_unlock(hashtext($1))", [
          `deployguard:normal-release-outcome-retry:${evidence.projectId}:dev:${evidence.intentId}`,
        ]).catch(() => undefined);
        await retryLock.release().catch(() => undefined);
      }
      await queue.close();
    }
  }

  /**
   * Finds one exact failed normal-release job inside the already-gated scope.
   * The scheduler still calls reconcileExact(), which repeats the full durable
   * and read-only evidence validation before retrying anything.
   */
  async findAutomaticCandidate(projectId: string) {
    if (!UUID.test(projectId)) return null;
    const values = this.rows<{ projectId: string; intentId: string }>(
      await this.dataSource.query(
        `SELECT intent.project_id AS "projectId", intent.id AS "intentId"
         FROM deployment_intents intent
         JOIN release_manifests candidate ON candidate.id = intent.release_manifest_id
         JOIN orchestration_outbox outbox ON outbox.intent_id = intent.id
         WHERE intent.project_id = $1 AND intent.environment_name = 'dev'
           AND intent.kind = 'deploy' AND intent.classification = 'release_only'
           AND (
             (intent.status = 'failed'
              AND intent.failure_code = 'RELEASE_EVIDENCE_AMBIGUOUS')
             OR (intent.status = 'enqueued' AND intent.failure_code IS NULL)
           )
           AND candidate.status = 'deploying'
           AND outbox.status = 'published' AND outbox.attempt_count = 1
           AND outbox.published_job_id IS NOT NULL
           AND outbox.claimed_by IS NULL AND outbox.claim_expires_at IS NULL
           AND NOT EXISTS (
             SELECT 1 FROM project_operation_leases lease
             WHERE lease.intent_id = intent.id
               AND lease.status IN ('acquired','heartbeat_active')
               AND lease.expires_at > clock_timestamp()
           )
           AND NOT EXISTS (
             SELECT 1 FROM project_release_lane_ownerships ownership
             WHERE ownership.project_id = intent.project_id
               AND ownership.environment_name = intent.environment_name
               AND ownership.status IN ('acquired','heartbeat_active')
               AND ownership.expires_at > clock_timestamp()
           )
         ORDER BY intent.updated_at ASC, intent.id ASC
         LIMIT 1`,
        [projectId],
      ),
    );
    return values.length === 1 ? values[0].intentId : null;
  }

  /**
   * Shared workers have no project UUID at process startup. Discover one
   * bounded candidate, then pass its exact project/intent identity back
   * through reconcileExact(), which repeats the complete durable, queue and
   * read-only cloud-evidence validation under the project advisory lock.
   */
  async findAutomaticCandidateAcrossProjects() {
    const values = this.rows<{ projectId: string; intentId: string }>(
      await this.dataSource.query(
        `SELECT intent.project_id AS "projectId", intent.id AS "intentId"
         FROM deployment_intents intent
         JOIN release_manifests candidate ON candidate.id = intent.release_manifest_id
         JOIN orchestration_outbox outbox ON outbox.intent_id = intent.id
         WHERE intent.environment_name = 'dev'
           AND intent.kind = 'deploy' AND intent.classification = 'release_only'
           AND (
             (intent.status = 'failed'
              AND intent.failure_code = 'RELEASE_EVIDENCE_AMBIGUOUS')
             OR (intent.status = 'enqueued' AND intent.failure_code IS NULL)
           )
           AND candidate.status = 'deploying'
           AND outbox.status = 'published' AND outbox.attempt_count = 1
           AND outbox.published_job_id IS NOT NULL
           AND outbox.claimed_by IS NULL AND outbox.claim_expires_at IS NULL
           AND NOT EXISTS (
             SELECT 1 FROM project_operation_leases lease
             WHERE lease.intent_id = intent.id
               AND lease.status IN ('acquired','heartbeat_active')
               AND lease.expires_at > clock_timestamp()
           )
           AND NOT EXISTS (
             SELECT 1 FROM project_release_lane_ownerships ownership
             WHERE ownership.project_id = intent.project_id
               AND ownership.environment_name = intent.environment_name
               AND ownership.status IN ('acquired','heartbeat_active')
               AND ownership.expires_at > clock_timestamp()
           )
         ORDER BY intent.updated_at ASC, intent.project_id ASC, intent.id ASC
         LIMIT 1`,
      ),
    );
    return values.length === 1 ? values[0] : null;
  }

  private async loadExact(projectId: string, intentId: string) {
    const values = this.rows<ConvergenceEvidence>(
      await this.dataSource.query(
        `SELECT intent.id AS "intentId", intent.project_id AS "projectId",
                project.owner_user_id AS "actorId", candidate.id AS "candidateId",
                candidate.image_digest AS "candidateDigest",
                candidate.task_definition_arn AS "candidateTaskDefinitionArn",
                infrastructure.id AS "infrastructureId",
                stable.id AS "stableId",
                stable.previous_stable_manifest_id AS "stablePreviousManifestId",
                infrastructure.terraform_outputs->>'ecs_cluster_arn' AS "clusterArn",
                stable.initial_service_arn AS "serviceArn",
                infrastructure.terraform_outputs->>'ecr_repository_name'
                  AS "ecrRepositoryName",
                outbox.published_job_id AS "publishedJobId",
                intent.status, intent.failure_code AS "failureCode"
         FROM deployment_intents intent
         JOIN projects project ON project.id = intent.project_id
         JOIN release_manifests candidate ON candidate.id = intent.release_manifest_id
         JOIN infrastructure_manifests infrastructure
           ON infrastructure.id = intent.infrastructure_manifest_id
         JOIN release_manifests stable
           ON stable.id = candidate.previous_stable_manifest_id
         JOIN orchestration_outbox outbox ON outbox.intent_id = intent.id
         WHERE intent.id = $1 AND intent.project_id = $2
           AND intent.environment_name = 'dev'
           AND intent.kind = 'deploy' AND intent.classification = 'release_only'
           AND intent.status IN ('failed','enqueued')
           AND (intent.status = 'enqueued'
             OR intent.failure_code = 'RELEASE_EVIDENCE_AMBIGUOUS')
           AND candidate.status = 'deploying'
           AND candidate.image_digest ~ '^sha256:[0-9a-f]{64}$'
           AND candidate.task_definition_arn IS NOT NULL
           AND infrastructure.status = 'applied' AND stable.status = 'stable'
           AND outbox.status = 'published' AND outbox.attempt_count = 1
           AND outbox.published_at IS NOT NULL
           AND outbox.published_job_id IS NOT NULL
           AND outbox.claimed_by IS NULL AND outbox.claim_expires_at IS NULL
           AND EXISTS (
             SELECT 1 FROM release_image_provenances provenance
             WHERE provenance.intent_id = intent.id
               AND provenance.project_id = intent.project_id
               AND provenance.environment_name = intent.environment_name
               AND provenance.infrastructure_manifest_id = infrastructure.id
               AND provenance.commit_sha = candidate.commit_sha
               AND provenance.image_digest = candidate.image_digest
           )
           AND 3 = (
             SELECT count(*) FROM deployment_side_effects effect
             WHERE effect.intent_id = intent.id AND effect.status = 'succeeded'
               AND effect.effect_type IN (
                 'ecr.build_push_immutable_image',
                 'ecs.register_task_definition_revision',
                 'ecs.update_existing_service'
               )
           )
           AND NOT EXISTS (
             SELECT 1 FROM deployment_side_effects effect
             WHERE effect.intent_id = intent.id
               AND (effect.status <> 'succeeded'
                 OR effect.effect_type NOT IN (
                   'ecr.build_push_immutable_image',
                   'ecs.register_task_definition_revision',
                   'ecs.update_existing_service'
                 ))
           )
           AND NOT EXISTS (
             SELECT 1 FROM project_operation_leases lease
             WHERE lease.intent_id = intent.id
               AND lease.status IN ('acquired','heartbeat_active')
               AND lease.expires_at > clock_timestamp()
           )
           AND NOT EXISTS (
             SELECT 1 FROM project_release_lane_ownerships ownership
             WHERE ownership.project_id = intent.project_id
               AND ownership.environment_name = intent.environment_name
               AND ownership.status IN ('acquired','heartbeat_active')
               AND ownership.expires_at > clock_timestamp()
           )`,
        [intentId, projectId],
      ),
    );
    if (values.length !== 1) return null;
    const evidence = values[0];
    if (!evidence.serviceArn) {
      evidence.serviceArn = await resolveReleaseServiceArn(
        {
          id: evidence.stableId,
          previousStableManifestId: evidence.stablePreviousManifestId,
          initialServiceArn: null,
        },
        async (releaseManifestId) => {
          const ancestors = this.rows<{
            id: string;
            previousStableManifestId: string | null;
            initialServiceArn: string | null;
          }>(
            await this.dataSource.query(
              `SELECT id,
                      previous_stable_manifest_id AS "previousStableManifestId",
                      initial_service_arn AS "initialServiceArn"
               FROM release_manifests
               WHERE id = $1 AND project_id = $2 AND environment_name = 'dev'
                 AND infrastructure_manifest_id = $3
                 AND status IN ('stable','superseded')`,
              [releaseManifestId, evidence.projectId, evidence.infrastructureId],
            ),
          );
          return ancestors.length === 1 ? ancestors[0] : null;
        },
      );
    }
    return evidence.serviceArn ? evidence : null;
  }

  private async readOnlyIdentityConverged(evidence: ConvergenceEvidence) {
    if (
      !DIGEST.test(evidence.candidateDigest)
      || !evidence.clusterArn
      || !evidence.serviceArn
      || !evidence.candidateTaskDefinitionArn
      || !evidence.ecrRepositoryName
    ) return false;
    const local = this.localFixture?.inspectConvergence({
      projectId: evidence.projectId,
      candidateDigest: evidence.candidateDigest,
      candidateTaskDefinitionArn: evidence.candidateTaskDefinitionArn,
      serviceArn: evidence.serviceArn,
      ecrRepositoryName: evidence.ecrRepositoryName,
    });
    if (local !== null && local !== undefined) return local;
    try {
      const region = this.config.get<string>("AWS_REGION");
      if (!region) return false;
      const [image, service] = await Promise.all([
        new ECRClient({ region }).send(new DescribeImagesCommand({
          repositoryName: evidence.ecrRepositoryName,
          imageIds: [{ imageDigest: evidence.candidateDigest }],
        })),
        new ECSClient({ region }).send(new DescribeServicesCommand({
          cluster: evidence.clusterArn,
          services: [evidence.serviceArn],
        })),
      ]);
      const exactService = service.services?.length === 1
        && !(service.failures?.length)
        ? service.services[0]
        : null;
      const primary = exactService?.deployments?.filter((deployment) =>
        deployment.status === "PRIMARY"
        && deployment.taskDefinition === evidence.candidateTaskDefinitionArn
      ) ?? [];
      return image.imageDetails?.length === 1
        && image.imageDetails[0].imageDigest === evidence.candidateDigest
        && exactService?.status === "ACTIVE"
        && exactService.clusterArn === evidence.clusterArn
        && exactService.serviceArn === evidence.serviceArn
        && exactService.taskDefinition === evidence.candidateTaskDefinitionArn
        && exactService.runningCount === exactService.desiredCount
        && exactService.pendingCount === 0
        && primary.length === 1
        && primary[0].rolloutState === "COMPLETED";
    } catch {
      return false;
    }
  }

  private async resume(evidence: ConvergenceEvidence) {
    return this.dataSource.transaction("SERIALIZABLE", async (manager) => {
      await manager.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        `deployguard:normal-release-outcome-reconciliation:${evidence.projectId}:dev`,
      ]);
      const values = this.rows<{ status: string; failureCode: string | null }>(
        await manager.query(
          `SELECT status, failure_code AS "failureCode"
           FROM deployment_intents
           WHERE id = $1 AND project_id = $2 AND environment_name = 'dev'
           FOR UPDATE`,
          [evidence.intentId, evidence.projectId],
        ),
      );
      const intent = values[0];
      if (intent?.status === "enqueued") return true;
      if (
        intent?.status !== "failed"
        || intent.failureCode !== "RELEASE_EVIDENCE_AMBIGUOUS"
      ) return false;
      const updated = this.rows(
        await manager.query(
          `UPDATE deployment_intents
           SET status = 'enqueued', completed_at = NULL, failure_code = NULL,
               failure_message = NULL, updated_at = clock_timestamp()
           WHERE id = $1 AND status = 'failed'
             AND failure_code = 'RELEASE_EVIDENCE_AMBIGUOUS'
             AND NOT EXISTS (
               SELECT 1 FROM project_operation_leases lease
               WHERE lease.intent_id = deployment_intents.id
                 AND lease.status IN ('acquired','heartbeat_active')
               AND lease.expires_at > clock_timestamp()
             )
           AND NOT EXISTS (
             SELECT 1 FROM project_release_lane_ownerships ownership
             WHERE ownership.project_id = deployment_intents.project_id
               AND ownership.environment_name = deployment_intents.environment_name
               AND ownership.status IN ('acquired','heartbeat_active')
               AND ownership.expires_at > clock_timestamp()
           )
           RETURNING id`,
          [evidence.intentId],
        ),
      );
      if (updated.length !== 1) return false;
      await manager.query(
        `INSERT INTO audit_logs (
           actor_user_id, action, category, resource_type, resource_id,
           status, metadata
         )
         SELECT $1, 'normal_release.resume_for_outcome_reconciliation',
                'release', 'deployment_intent', $2::text, 'resumed',
                jsonb_build_object(
                  'projectId', $3::uuid,
                  'environment', 'dev',
                  'reason',
                  'verified_succeeded_mutations_pending_outcome_reconciliation'
                )
         WHERE NOT EXISTS (
           SELECT 1 FROM audit_logs
           WHERE action = 'normal_release.resume_for_outcome_reconciliation'
             AND resource_type = 'deployment_intent'
             AND resource_id = $2::text
         )`,
        [evidence.actorId, evidence.intentId, evidence.projectId],
      );
      return true;
    });
  }

  private withinBounds(
    job: { attemptsMade: number; timestamp: number },
    bounds: NormalReleaseLaneConvergenceBounds,
  ) {
    if (
      !Number.isInteger(bounds.maxAttempts)
      || bounds.maxAttempts < 2
      || bounds.maxAttempts > 5
      || !Number.isInteger(bounds.maxElapsedMs)
      || bounds.maxElapsedMs < 60_000
      || bounds.maxElapsedMs > 1_800_000
      || !Number.isInteger(job.attemptsMade)
      || !Number.isFinite(job.timestamp)
    ) return false;
    return job.attemptsMade < bounds.maxAttempts
      && Date.now() - job.timestamp <= bounds.maxElapsedMs;
  }

  private async markBoundExhausted(
    evidence: ConvergenceEvidence,
    bounds: NormalReleaseLaneConvergenceBounds,
  ) {
    return this.dataSource.transaction("SERIALIZABLE", async (manager) => {
      await manager.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        `deployguard:normal-release-outcome-reconciliation:${evidence.projectId}:dev`,
      ]);
      const updated = this.rows(
        await manager.query(
          `UPDATE deployment_intents
           SET failure_code = 'NORMAL_RELEASE_CONVERGENCE_BOUND_EXHAUSTED',
               failure_message = NULL, completed_at = COALESCE(completed_at, clock_timestamp()),
               updated_at = clock_timestamp()
           WHERE id = $1 AND project_id = $2 AND environment_name = 'dev'
             AND status = 'failed'
             AND failure_code = 'RELEASE_EVIDENCE_AMBIGUOUS'
             AND NOT EXISTS (
               SELECT 1 FROM project_operation_leases lease
               WHERE lease.intent_id = deployment_intents.id
                 AND lease.status IN ('acquired','heartbeat_active')
                 AND lease.expires_at > clock_timestamp()
             )
           RETURNING id`,
          [evidence.intentId, evidence.projectId],
        ),
      );
      if (updated.length !== 1) return false;
      await manager.query(
        `INSERT INTO audit_logs (
           actor_user_id, action, category, resource_type, resource_id,
           status, metadata
         ) VALUES (
           $1, 'normal_release.auto_convergence_exhausted', 'release',
           'deployment_intent', $2::text, 'exhausted',
           jsonb_build_object(
             'projectId', $3::uuid,
             'environment', 'dev',
             'maxAttempts', $4::integer,
             'maxElapsedMs', $5::integer
           )
         )`,
        [
          evidence.actorId,
          evidence.intentId,
          evidence.projectId,
          bounds.maxAttempts,
          bounds.maxElapsedMs,
        ],
      );
      return true;
    });
  }

  private result(
    state: NormalReleaseLaneConvergenceResult["state"],
    safeCode: string,
  ): NormalReleaseLaneConvergenceResult {
    return Object.freeze({ state, safeCodes: Object.freeze([safeCode] as [string]) });
  }

  private rows<T>(value: unknown): T[] {
    return Array.isArray(value) && Array.isArray(value[0])
      ? value[0] as T[]
      : Array.isArray(value) ? value as T[] : [];
  }
}
