import { DataSource, EntityManager } from "typeorm";
import {
  V1EcsReleaseOutcomeError,
  V1EcsReleaseOutcomeFence,
  V1EcsReleaseOutcomeStore,
  V1EcsRollbackPreparation,
} from "./inactive-v1-ecs-release-outcome.types";
import {
  InactiveV1StableReleaseProjectionStore,
  V1StableReleaseProjectionStore,
} from "./inactive-v1-stable-release-projection.store";

type ReleaseRow = {
  id: string;
  projectId: string;
  environmentName: string;
  revision: string;
  previousStableManifestId: string | null;
  infrastructureManifestId: string;
  status: string;
  taskDefinitionArn: string | null;
  healthEvidence: Record<string, unknown> | null;
};

type RollbackRow = ReleaseRow & {
  rollbackManifestId: string;
  rollbackRevision: string;
  previousStableRevision: string;
  infrastructureRevision: string;
  clusterArn: string;
  serviceArn: string;
};

type OutcomeMetadata = {
  schemaVersion: 1;
  idempotencyKey: string;
  inputFingerprint: string;
  evidenceHash: string;
  safeCode: string;
};

const ECS_CLUSTER_ARN =
  /^arn:(?:aws|aws-us-gov|aws-cn):ecs:[a-z0-9-]+:[0-9]{12}:cluster\/[A-Za-z0-9_.\/-]+$/;
const ECS_SERVICE_ARN =
  /^arn:(?:aws|aws-us-gov|aws-cn):ecs:[a-z0-9-]+:[0-9]{12}:service\/[A-Za-z0-9_.\/-]+$/;
const TASK_DEFINITION_ARN =
  /^arn:(?:aws|aws-us-gov|aws-cn):ecs:[a-z0-9-]+:[0-9]{12}:task-definition\/[A-Za-z0-9_.\/-]+:[1-9][0-9]*$/;

export class InactiveV1EcsReleaseOutcomeStore
implements V1EcsReleaseOutcomeStore {
  private readonly projection: V1StableReleaseProjectionStore;

  constructor(
    private readonly dataSource: DataSource,
    projection?: V1StableReleaseProjectionStore,
  ) {
    this.projection = projection
      ?? new InactiveV1StableReleaseProjectionStore(dataSource);
  }

  async promoteCandidate(
    input: Parameters<V1EcsReleaseOutcomeStore["promoteCandidate"]>[0],
  ) {
    return this.serializable(async (manager) => {
      await this.acquirePromotionLock(
        manager,
        input.revision.projectId,
        input.revision.environmentName,
      );
      await this.assertFence(manager, input.revision, input.fence);
      const candidate = await this.lockCandidate(manager, input.revision);
      const metadata: OutcomeMetadata = {
        schemaVersion: 1,
        idempotencyKey: input.idempotencyKey,
        inputFingerprint: input.inputFingerprint,
        evidenceHash: input.verification.evidenceHash,
        safeCode: input.verification.safeCode,
      };
      const existing = this.metadata(
        candidate.healthEvidence,
        "promotion",
      );
      if (candidate.status === "stable") {
        this.assertMetadata(existing, metadata);
        await this.projection.syncWithinTransaction(manager, candidate.id);
        return { disposition: "replayed" as const };
      }
      this.assertFreshMetadata(existing, metadata);
      if (
        !candidate.taskDefinitionArn
        || !TASK_DEFINITION_ARN.test(candidate.taskDefinitionArn)
        || ![
          "deploying",
          "waiting_for_stability",
          "health_checking",
          "healthy",
        ].includes(candidate.status)
      ) {
        throw new V1EcsReleaseOutcomeError(
          "ECS_RELEASE_OUTCOME_TRANSITION_CONFLICT",
        );
      }
      const currentStable = await this.lockCurrentStable(
        manager,
        candidate.projectId,
        candidate.environmentName,
        candidate.id,
      );
      if (
        (currentStable?.id ?? null)
        !== candidate.previousStableManifestId
      ) {
        throw new V1EcsReleaseOutcomeError(
          "ECS_RELEASE_OUTCOME_TRANSITION_CONFLICT",
        );
      }
      if (currentStable) {
        const superseded = await manager.query(
          `UPDATE release_manifests
           SET status = 'superseded',
               superseded_at = clock_timestamp(),
               updated_at = clock_timestamp()
           WHERE id = $1 AND status = 'stable'
           RETURNING id`,
          [currentStable.id],
        );
        if (this.rows(superseded).length !== 1) {
          throw new V1EcsReleaseOutcomeError(
            "ECS_RELEASE_OUTCOME_TRANSITION_CONFLICT",
          );
        }
      }
      const result = await manager.query(
        `UPDATE release_manifests
         SET status = 'stable',
             health_verified_at = clock_timestamp(),
             promoted_at = clock_timestamp(),
             failure_code = NULL,
             failure_message = NULL,
             health_evidence = COALESCE(health_evidence, '{}'::jsonb)
               || jsonb_build_object('promotion', $7::jsonb),
             updated_at = clock_timestamp()
         WHERE id = $1
           AND project_id = $2
           AND environment_name = $3
           AND revision = $4::bigint
           AND infrastructure_manifest_id = $5
           AND status IN (
             'deploying','waiting_for_stability','health_checking','healthy'
           )
           AND EXISTS (
             SELECT 1 FROM infrastructure_manifests infrastructure
             WHERE infrastructure.id = $5
               AND infrastructure.revision = $6::bigint
               AND infrastructure.status = 'applied'
           )
         RETURNING id`,
        [
          candidate.id,
          candidate.projectId,
          candidate.environmentName,
          candidate.revision,
          candidate.infrastructureManifestId,
          input.revision.infrastructureRevision,
          JSON.stringify(metadata),
        ],
      );
      if (this.rows(result).length !== 1) {
        throw new V1EcsReleaseOutcomeError(
          "ECS_RELEASE_OUTCOME_TRANSITION_CONFLICT",
        );
      }
      await this.projection.syncWithinTransaction(manager, candidate.id);
      return { disposition: "promoted" as const };
    });
  }

  async prepareRollback(
    input: Parameters<V1EcsReleaseOutcomeStore["prepareRollback"]>[0],
  ): Promise<V1EcsRollbackPreparation> {
    return this.serializable(async (manager) => {
      await this.acquirePromotionLock(
        manager,
        input.revision.projectId,
        input.revision.environmentName,
      );
      await this.assertFence(manager, input.revision, input.fence);
      const candidate = await this.lockCandidate(manager, input.revision);
      const metadata: OutcomeMetadata = {
        schemaVersion: 1,
        idempotencyKey: input.idempotencyKey,
        inputFingerprint: input.inputFingerprint,
        evidenceHash: input.candidateVerification.evidenceHash,
        safeCode: input.candidateVerification.safeCode,
      };
      const existing = await this.lockRollbackManifest(
        manager,
        candidate.id,
      );
      if (existing) {
        this.assertMetadata(
          this.metadata(existing.healthEvidence, "rollbackRequest"),
          metadata,
        );
        return {
          disposition: "rollback_replayed",
          target: this.rollbackTarget(existing, candidate),
        };
      }
      this.assertFreshMetadata(
        this.metadata(candidate.healthEvidence, "rollbackRequest"),
        metadata,
      );
      const currentStable = await this.lockCurrentStable(
        manager,
        candidate.projectId,
        candidate.environmentName,
        candidate.id,
      );
      if (
        !currentStable
        || !candidate.previousStableManifestId
        || currentStable.id !== candidate.previousStableManifestId
      ) {
        await this.markMissingTarget(
          manager,
          candidate,
          metadata,
          "ECS_PREVIOUS_STABLE_RELEASE_MISSING",
        );
        return {
          disposition: "rollback_target_missing",
          safeCode: "ECS_PREVIOUS_STABLE_RELEASE_MISSING",
        };
      }
      if (
        currentStable.infrastructureManifestId
          !== candidate.infrastructureManifestId
      ) {
        await this.markMissingTarget(
          manager,
          candidate,
          metadata,
          "ECS_PREVIOUS_STABLE_INFRASTRUCTURE_MISMATCH",
        );
        return {
          disposition: "rollback_target_missing",
          safeCode: "ECS_PREVIOUS_STABLE_INFRASTRUCTURE_MISMATCH",
        };
      }
      if (
        !currentStable.taskDefinitionArn
        || !TASK_DEFINITION_ARN.test(currentStable.taskDefinitionArn)
      ) {
        await this.markMissingTarget(
          manager,
          candidate,
          metadata,
          "ECS_PREVIOUS_STABLE_RELEASE_MISSING",
        );
        return {
          disposition: "rollback_target_missing",
          safeCode: "ECS_PREVIOUS_STABLE_RELEASE_MISSING",
        };
      }
      const infrastructure = await this.appliedInfrastructure(
        manager,
        input.revision,
      );
      const clusterArn = infrastructure.ecs_cluster_arn;
      const serviceArn = infrastructure.ecs_service_arn;
      if (
        typeof clusterArn !== "string"
        || !ECS_CLUSTER_ARN.test(clusterArn)
        || typeof serviceArn !== "string"
        || !ECS_SERVICE_ARN.test(serviceArn)
      ) {
        throw new V1EcsReleaseOutcomeError(
          "ECS_RELEASE_OUTCOME_TRANSITION_CONFLICT",
        );
      }
      const inserted = await manager.query(
        `INSERT INTO release_manifests (
           schema_version, project_id, environment_name, revision,
           parent_manifest_id, previous_stable_manifest_id,
           infrastructure_manifest_id, created_by_intent_id,
           pipeline_run_id, deployment_contract_id,
           configuration_snapshot_id, origin, status, spec_hash,
           repository_full_name, branch, commit_sha, app_root,
           deployment_contract_hash, configuration_fingerprint,
           build_fingerprint, runtime_fingerprint, image_uri, image_digest,
           task_definition_input_hash, task_definition_arn, release_spec,
           health_evidence, rollback_started_at
         )
         SELECT
           1, previous.project_id, previous.environment_name,
           (
             SELECT COALESCE(MAX(all_releases.revision), 0) + 1
             FROM release_manifests all_releases
             WHERE all_releases.project_id = previous.project_id
               AND all_releases.environment_name = previous.environment_name
           ),
           candidate.id, previous.id, candidate.infrastructure_manifest_id,
           $3, candidate.pipeline_run_id, previous.deployment_contract_id,
           previous.configuration_snapshot_id, 'rollback',
           'rollback_started', previous.spec_hash,
           previous.repository_full_name, previous.branch,
           previous.commit_sha, previous.app_root,
           previous.deployment_contract_hash,
           previous.configuration_fingerprint,
           previous.build_fingerprint, previous.runtime_fingerprint,
           previous.image_uri, previous.image_digest,
           previous.task_definition_input_hash,
           previous.task_definition_arn, previous.release_spec,
           jsonb_build_object('rollbackRequest', $4::jsonb),
           clock_timestamp()
         FROM release_manifests previous
         INNER JOIN release_manifests candidate ON candidate.id = $1
         WHERE previous.id = $2
           AND previous.status = 'stable'
           AND candidate.status IN (
             'deploying','waiting_for_stability','health_checking','healthy',
             'failed','rollback_started'
           )
         RETURNING id AS "rollbackManifestId",
                   revision::text AS "rollbackRevision"`,
        [
          candidate.id,
          currentStable.id,
          input.fence.intentId,
          JSON.stringify(metadata),
        ],
      );
      const rows = this.rows(inserted) as Array<{
        rollbackManifestId: string;
        rollbackRevision: string;
      }>;
      if (rows.length !== 1) {
        throw new V1EcsReleaseOutcomeError(
          "ECS_RELEASE_OUTCOME_TRANSITION_CONFLICT",
        );
      }
      await manager.query(
        `UPDATE release_manifests
         SET status = 'rollback_started',
             rollback_started_at = COALESCE(
               rollback_started_at, clock_timestamp()
             ),
             health_evidence = COALESCE(health_evidence, '{}'::jsonb)
               || jsonb_build_object('rollbackRequest', $2::jsonb),
             updated_at = clock_timestamp()
         WHERE id = $1`,
        [candidate.id, JSON.stringify(metadata)],
      );
      return {
        disposition: "rollback_prepared",
        target: {
          rollbackManifestId: rows[0].rollbackManifestId,
          rollbackRevision: rows[0].rollbackRevision,
          previousStable: {
            projectId: candidate.projectId,
            environmentName: candidate.environmentName,
            releaseManifestId: currentStable.id,
            releaseRevision: currentStable.revision,
            infrastructureManifestId: candidate.infrastructureManifestId,
            infrastructureRevision: input.revision.infrastructureRevision,
            taskDefinitionArn: currentStable.taskDefinitionArn,
          },
          clusterArn,
          serviceArn,
          inputFingerprint: input.inputFingerprint,
        },
      };
    });
  }

  async finalizeRollback(
    input: Parameters<V1EcsReleaseOutcomeStore["finalizeRollback"]>[0],
  ) {
    return this.serializable(async (manager) => {
      await this.acquirePromotionLock(
        manager,
        input.revision.projectId,
        input.revision.environmentName,
      );
      await this.assertFence(manager, input.revision, input.fence);
      const candidate = await this.lockCandidate(manager, input.revision);
      const rollback = await this.lockRelease(
        manager,
        input.rollbackManifestId,
      );
      const previous = await this.lockRelease(
        manager,
        input.previousStableManifestId,
      );
      const expected = {
        idempotencyKey: input.idempotencyKey,
        inputFingerprint: input.inputFingerprint,
      };
      const requestMetadata = this.metadata(
        rollback.healthEvidence,
        "rollbackRequest",
      );
      if (
        !requestMetadata
        || requestMetadata.idempotencyKey !== expected.idempotencyKey
        || requestMetadata.inputFingerprint !== expected.inputFingerprint
      ) {
        throw new V1EcsReleaseOutcomeError(
          "ECS_RELEASE_OUTCOME_IDEMPOTENCY_CONFLICT",
        );
      }
      if (
        candidate.status === "rolled_back"
        && rollback.status === "stable"
      ) {
        await this.projection.syncWithinTransaction(manager, rollback.id);
        return { disposition: "replayed" as const };
      }
      if (
        rollback.revision !== input.rollbackRevision
        || rollback.status !== "rollback_started"
        || rollback.previousStableManifestId !== previous.id
        || rollback.infrastructureManifestId
          !== candidate.infrastructureManifestId
        || previous.status !== "stable"
        || candidate.status !== "rollback_started"
      ) {
        throw new V1EcsReleaseOutcomeError(
          "ECS_RELEASE_OUTCOME_TRANSITION_CONFLICT",
        );
      }
      const superseded = await manager.query(
        `UPDATE release_manifests
         SET status = 'superseded',
             superseded_at = clock_timestamp(),
             updated_at = clock_timestamp()
         WHERE id = $1 AND status = 'stable'
         RETURNING id`,
        [previous.id],
      );
      if (this.rows(superseded).length !== 1) {
        throw new V1EcsReleaseOutcomeError(
          "ECS_RELEASE_OUTCOME_TRANSITION_CONFLICT",
        );
      }
      const candidateRolledBack = await manager.query(
        `UPDATE release_manifests
         SET status = 'rolled_back',
             rolled_back_at = clock_timestamp(),
             updated_at = clock_timestamp()
         WHERE id = $1 AND status = 'rollback_started'
         RETURNING id`,
        [candidate.id],
      );
      if (this.rows(candidateRolledBack).length !== 1) {
        throw new V1EcsReleaseOutcomeError(
          "ECS_RELEASE_OUTCOME_TRANSITION_CONFLICT",
        );
      }
      const result = await manager.query(
        `UPDATE release_manifests
         SET status = 'stable',
             health_verified_at = clock_timestamp(),
             promoted_at = clock_timestamp(),
             health_evidence = COALESCE(health_evidence, '{}'::jsonb)
               || jsonb_build_object(
                    'rollbackVerification',
                    jsonb_build_object(
                      'evidenceHash', $2::text,
                      'safeCode', $3::text
                    )
                  ),
             updated_at = clock_timestamp()
         WHERE id = $1 AND status = 'rollback_started'
         RETURNING id`,
        [
          rollback.id,
          input.verification.evidenceHash,
          input.verification.safeCode,
        ],
      );
      if (this.rows(result).length !== 1) {
        throw new V1EcsReleaseOutcomeError(
          "ECS_RELEASE_OUTCOME_TRANSITION_CONFLICT",
        );
      }
      await this.projection.syncWithinTransaction(manager, rollback.id);
      return { disposition: "rolled_back" as const };
    });
  }

  private async serializable<T>(
    work: (manager: EntityManager) => Promise<T>,
  ): Promise<T> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await this.dataSource.transaction("SERIALIZABLE", work);
      } catch (error) {
        const code = (error as { code?: string })?.code;
        if (
          attempt < 2
          && (code === "40001" || code === "40P01")
        ) continue;
        throw error;
      }
    }
    throw new V1EcsReleaseOutcomeError(
      "ECS_RELEASE_OUTCOME_TRANSITION_CONFLICT",
    );
  }

  private async acquirePromotionLock(
    manager: EntityManager,
    projectId: string,
    environmentName: string,
  ) {
    await manager.query(
      `SELECT pg_advisory_xact_lock(
         hashtextextended($1::text, 0)
       )`,
      [`deployguard:release-promote:${projectId}:${environmentName}`],
    );
  }

  private async assertFence(
    manager: EntityManager,
    revision: {
      projectId: string;
      environmentName: string;
    },
    fence: V1EcsReleaseOutcomeFence,
  ) {
    const result = await manager.query(
      `SELECT lease.id
       FROM project_operation_leases lease
       INNER JOIN deployment_intents intent ON intent.id = lease.intent_id
       WHERE lease.id = $1
         AND lease.intent_id = $2
         AND lease.project_id = $3
         AND lease.environment_name = $4
         AND lease.owner_worker_id = $5
         AND lease.fencing_token = $6::bigint
         AND lease.status IN ('acquired','heartbeat_active')
         AND lease.expires_at > clock_timestamp()
         AND intent.status = 'running'
       FOR UPDATE`,
      [
        fence.leaseId,
        fence.intentId,
        revision.projectId,
        revision.environmentName,
        fence.workerId,
        fence.fencingToken,
      ],
    );
    if (this.rows(result).length !== 1) {
      throw new V1EcsReleaseOutcomeError(
        "ECS_RELEASE_OUTCOME_OWNERSHIP_LOST",
      );
    }
  }

  private async lockCandidate(
    manager: EntityManager,
    revision: {
      projectId: string;
      environmentName: string;
      releaseManifestId: string;
      releaseRevision: string;
      infrastructureManifestId: string;
      infrastructureRevision: string;
    },
  ) {
    const result = await manager.query(
      `SELECT release.id,
              release.project_id AS "projectId",
              release.environment_name AS "environmentName",
              release.revision::text AS revision,
              release.previous_stable_manifest_id AS "previousStableManifestId",
              release.infrastructure_manifest_id AS "infrastructureManifestId",
              release.status,
              release.task_definition_arn AS "taskDefinitionArn",
              release.health_evidence AS "healthEvidence"
       FROM release_manifests release
       INNER JOIN infrastructure_manifests infrastructure
         ON infrastructure.id = release.infrastructure_manifest_id
       WHERE release.id = $1
         AND release.revision = $2::bigint
         AND release.project_id = $3
         AND release.environment_name = $4
         AND release.infrastructure_manifest_id = $5
         AND infrastructure.revision = $6::bigint
         AND infrastructure.status = 'applied'
       FOR UPDATE OF release`,
      [
        revision.releaseManifestId,
        revision.releaseRevision,
        revision.projectId,
        revision.environmentName,
        revision.infrastructureManifestId,
        revision.infrastructureRevision,
      ],
    );
    const rows = this.rows(result) as ReleaseRow[];
    if (rows.length !== 1) {
      throw new V1EcsReleaseOutcomeError(
        "ECS_RELEASE_OUTCOME_TRANSITION_CONFLICT",
      );
    }
    return rows[0];
  }

  private async lockCurrentStable(
    manager: EntityManager,
    projectId: string,
    environmentName: string,
    excludedId: string,
  ) {
    const result = await manager.query(
      `SELECT id,
              project_id AS "projectId",
              environment_name AS "environmentName",
              revision::text AS revision,
              previous_stable_manifest_id AS "previousStableManifestId",
              infrastructure_manifest_id AS "infrastructureManifestId",
              status,
              task_definition_arn AS "taskDefinitionArn",
              health_evidence AS "healthEvidence"
       FROM release_manifests
       WHERE project_id = $1
         AND environment_name = $2
         AND status = 'stable'
         AND id <> $3
       FOR UPDATE`,
      [projectId, environmentName, excludedId],
    );
    const rows = this.rows(result) as ReleaseRow[];
    if (rows.length > 1) {
      throw new V1EcsReleaseOutcomeError(
        "ECS_RELEASE_OUTCOME_TRANSITION_CONFLICT",
      );
    }
    return rows[0] ?? null;
  }

  private async lockRollbackManifest(
    manager: EntityManager,
    candidateId: string,
  ): Promise<RollbackRow | null> {
    const result = await manager.query(
      `SELECT rollback.id,
              rollback.id AS "rollbackManifestId",
              rollback.project_id AS "projectId",
              rollback.environment_name AS "environmentName",
              rollback.revision::text AS revision,
              rollback.revision::text AS "rollbackRevision",
              rollback.previous_stable_manifest_id
                AS "previousStableManifestId",
              rollback.infrastructure_manifest_id
                AS "infrastructureManifestId",
              rollback.status,
              rollback.task_definition_arn AS "taskDefinitionArn",
              rollback.health_evidence AS "healthEvidence",
              previous.revision::text AS "previousStableRevision",
              infrastructure.revision::text AS "infrastructureRevision",
              infrastructure.terraform_outputs->>'ecs_cluster_arn'
                AS "clusterArn",
              infrastructure.terraform_outputs->>'ecs_service_arn'
                AS "serviceArn"
       FROM release_manifests rollback
       INNER JOIN release_manifests previous
         ON previous.id = rollback.previous_stable_manifest_id
       INNER JOIN infrastructure_manifests infrastructure
         ON infrastructure.id = rollback.infrastructure_manifest_id
        AND infrastructure.status = 'applied'
       WHERE rollback.parent_manifest_id = $1
         AND rollback.origin = 'rollback'
       ORDER BY rollback.revision DESC
       FOR UPDATE`,
      [candidateId],
    );
    const rows = this.rows(result) as RollbackRow[];
    if (rows.length > 1) {
      throw new V1EcsReleaseOutcomeError(
        "ECS_RELEASE_OUTCOME_TRANSITION_CONFLICT",
      );
    }
    return rows[0] ?? null;
  }

  private async lockRelease(manager: EntityManager, id: string) {
    const result = await manager.query(
      `SELECT id,
              project_id AS "projectId",
              environment_name AS "environmentName",
              revision::text AS revision,
              previous_stable_manifest_id AS "previousStableManifestId",
              infrastructure_manifest_id AS "infrastructureManifestId",
              status,
              task_definition_arn AS "taskDefinitionArn",
              health_evidence AS "healthEvidence"
       FROM release_manifests WHERE id = $1 FOR UPDATE`,
      [id],
    );
    const rows = this.rows(result) as ReleaseRow[];
    if (rows.length !== 1) {
      throw new V1EcsReleaseOutcomeError(
        "ECS_RELEASE_OUTCOME_TRANSITION_CONFLICT",
      );
    }
    return rows[0];
  }

  private async appliedInfrastructure(
    manager: EntityManager,
    revision: {
      infrastructureManifestId: string;
      infrastructureRevision: string;
      projectId: string;
      environmentName: string;
    },
  ): Promise<Record<string, unknown>> {
    const result = await manager.query(
      `SELECT terraform_outputs AS outputs
       FROM infrastructure_manifests
       WHERE id = $1
         AND revision = $2::bigint
         AND project_id = $3
         AND environment_name = $4
         AND status = 'applied'
       FOR UPDATE`,
      [
        revision.infrastructureManifestId,
        revision.infrastructureRevision,
        revision.projectId,
        revision.environmentName,
      ],
    );
    const rows = this.rows(result) as Array<{
      outputs: Record<string, unknown> | null;
    }>;
    if (rows.length !== 1 || !rows[0].outputs) {
      throw new V1EcsReleaseOutcomeError(
        "ECS_RELEASE_OUTCOME_TRANSITION_CONFLICT",
      );
    }
    return rows[0].outputs;
  }

  private async markMissingTarget(
    manager: EntityManager,
    candidate: ReleaseRow,
    metadata: OutcomeMetadata,
    safeCode: string,
  ) {
    await manager.query(
      `UPDATE release_manifests
       SET status = 'failed',
           failure_code = $2,
           failure_message = NULL,
           health_evidence = COALESCE(health_evidence, '{}'::jsonb)
             || jsonb_build_object('rollbackRequest', $3::jsonb),
           updated_at = clock_timestamp()
       WHERE id = $1`,
      [candidate.id, safeCode, JSON.stringify(metadata)],
    );
  }

  private rollbackTarget(
    rollback: RollbackRow,
    candidate: ReleaseRow,
  ) {
    if (
      !rollback.previousStableManifestId
      || !rollback.taskDefinitionArn
      || !TASK_DEFINITION_ARN.test(rollback.taskDefinitionArn)
      || !ECS_CLUSTER_ARN.test(rollback.clusterArn)
      || !ECS_SERVICE_ARN.test(rollback.serviceArn)
    ) {
      throw new V1EcsReleaseOutcomeError(
        "ECS_RELEASE_OUTCOME_TRANSITION_CONFLICT",
      );
    }
    const request = this.metadata(
      rollback.healthEvidence,
      "rollbackRequest",
    )!;
    return {
      rollbackManifestId: rollback.id,
      rollbackRevision: rollback.revision,
      previousStable: {
        projectId: candidate.projectId,
        environmentName: candidate.environmentName,
        releaseManifestId: rollback.previousStableManifestId,
        releaseRevision: rollback.previousStableRevision,
        infrastructureManifestId: candidate.infrastructureManifestId,
        infrastructureRevision: rollback.infrastructureRevision,
        taskDefinitionArn: rollback.taskDefinitionArn,
      },
      clusterArn: rollback.clusterArn,
      serviceArn: rollback.serviceArn,
      inputFingerprint: request.inputFingerprint,
    };
  }

  private metadata(
    evidence: Record<string, unknown> | null,
    key: string,
  ): OutcomeMetadata | null {
    const value = evidence?.[key];
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return null;
    }
    return value as OutcomeMetadata;
  }

  private assertFreshMetadata(
    current: OutcomeMetadata | null,
    expected: OutcomeMetadata,
  ) {
    if (current) this.assertMetadata(current, expected);
  }

  private assertMetadata(
    current: OutcomeMetadata | null,
    expected: OutcomeMetadata,
  ) {
    if (
      !current
      || current.idempotencyKey !== expected.idempotencyKey
      || current.inputFingerprint !== expected.inputFingerprint
    ) {
      throw new V1EcsReleaseOutcomeError(
        "ECS_RELEASE_OUTCOME_IDEMPOTENCY_CONFLICT",
      );
    }
  }

  private rows(result: unknown): unknown[] {
    if (
      Array.isArray(result)
      && result.length === 2
      && Array.isArray(result[0])
    ) return result[0];
    return Array.isArray(result) ? result : [];
  }
}
