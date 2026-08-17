import { DataSource, EntityManager } from "typeorm";
import { V1EcsReleaseOutcomeError } from
  "./inactive-v1-ecs-release-outcome.types";

export type V1CanonicalStableReleaseProjection = {
  releaseManifestId: string;
  projectId: string;
  environmentName: string;
  releaseRevision: string;
  commitSha: string;
  imageUri: string;
  taskDefinitionArn: string;
  ecsServiceArn: string | null;
  healthCheckPath: string;
  appPort: number;
  pipelineRunId: string | null;
  deployedAt: Date;
};

export interface V1StableReleaseProjectionStore {
  syncWithinTransaction(
    manager: EntityManager,
    releaseManifestId: string,
  ): Promise<V1CanonicalStableReleaseProjection>;
}

type ProjectionRow = V1CanonicalStableReleaseProjection;

export class InactiveV1StableReleaseProjectionStore
implements V1StableReleaseProjectionStore {
  constructor(private readonly dataSource: DataSource) {}

  async syncWithinTransaction(
    manager: EntityManager,
    releaseManifestId: string,
  ): Promise<V1CanonicalStableReleaseProjection> {
    const canonical = await this.canonicalWithinTransaction(
      manager,
      releaseManifestId,
    );
    const superseded = await manager.query(
      `UPDATE project_stable_releases
       SET status = 'superseded',
           updated_at = clock_timestamp()
       WHERE project_id = $1
         AND environment_name = $2
         AND status = 'stable'
         AND release_manifest_id IS DISTINCT FROM $3
       RETURNING id`,
      [
        canonical.projectId,
        canonical.environmentName,
        canonical.releaseManifestId,
      ],
    );
    if (this.rows(superseded).length > 1) {
      throw new V1EcsReleaseOutcomeError(
        "ECS_RELEASE_OUTCOME_TRANSITION_CONFLICT",
      );
    }
    const existing = await manager.query(
      `SELECT id
       FROM project_stable_releases
       WHERE release_manifest_id = $1
       FOR UPDATE`,
      [canonical.releaseManifestId],
    );
    const existingRows = this.rows(existing) as Array<{ id: string }>;
    if (existingRows.length > 1) {
      throw new V1EcsReleaseOutcomeError(
        "ECS_RELEASE_OUTCOME_TRANSITION_CONFLICT",
      );
    }
    const metadata = JSON.stringify({
      schemaVersion: 1,
      source: "release_manifests",
      releaseManifestId: canonical.releaseManifestId,
      releaseRevision: canonical.releaseRevision,
    });
    const persisted = existingRows[0]
      ? await manager.query(
        `UPDATE project_stable_releases
         SET project_id = $2,
             environment_name = $3,
             commit_sha = $4,
             short_commit_sha = $5,
             image_uri = $6,
             task_definition_arn = $7,
             ecs_service_arn = $8,
             health_check_path = $9,
             app_port = $10,
             deployed_by_pipeline_run_id = $11,
             deployed_at = $12,
             status = 'stable',
             metadata = $13::jsonb,
             updated_at = clock_timestamp()
         WHERE id = $1
         RETURNING id`,
        [
          existingRows[0].id,
          canonical.projectId,
          canonical.environmentName,
          canonical.commitSha,
          canonical.commitSha.slice(0, 12),
          canonical.imageUri,
          canonical.taskDefinitionArn,
          canonical.ecsServiceArn,
          canonical.healthCheckPath,
          canonical.appPort,
          canonical.pipelineRunId,
          canonical.deployedAt,
          metadata,
        ],
      )
      : await manager.query(
        `INSERT INTO project_stable_releases (
           project_id, release_manifest_id, environment_name, commit_sha,
           short_commit_sha, image_uri, task_definition_arn,
           ecs_service_arn, health_check_path, app_port,
           deployed_by_pipeline_run_id, deployed_at, status, metadata
         ) VALUES (
           $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'stable',$13::jsonb
         )
         RETURNING id`,
        [
          canonical.projectId,
          canonical.releaseManifestId,
          canonical.environmentName,
          canonical.commitSha,
          canonical.commitSha.slice(0, 12),
          canonical.imageUri,
          canonical.taskDefinitionArn,
          canonical.ecsServiceArn,
          canonical.healthCheckPath,
          canonical.appPort,
          canonical.pipelineRunId,
          canonical.deployedAt,
          metadata,
        ],
      );
    if (this.rows(persisted).length !== 1) {
      throw new V1EcsReleaseOutcomeError(
        "ECS_RELEASE_OUTCOME_TRANSITION_CONFLICT",
      );
    }
    const stable = await manager.query(
      `SELECT release_manifest_id AS "releaseManifestId"
       FROM project_stable_releases
       WHERE project_id = $1
         AND environment_name = $2
         AND status = 'stable'
       FOR UPDATE`,
      [canonical.projectId, canonical.environmentName],
    );
    const stableRows = this.rows(stable) as Array<{
      releaseManifestId: string | null;
    }>;
    if (
      stableRows.length !== 1
      || stableRows[0].releaseManifestId !== canonical.releaseManifestId
    ) {
      throw new V1EcsReleaseOutcomeError(
        "ECS_RELEASE_OUTCOME_TRANSITION_CONFLICT",
      );
    }
    return canonical;
  }

  async readCanonical(
    projectId: string,
    environmentName: string,
  ): Promise<V1CanonicalStableReleaseProjection | null> {
    const result = await this.dataSource.query(
      this.canonicalSelect(
        `release.project_id = $1
         AND release.environment_name = $2
         AND release.status = 'stable'`,
      ),
      [projectId, environmentName],
    );
    return this.oneProjection(result);
  }

  async readLegacyProjection(
    projectId: string,
    environmentName: string,
  ): Promise<V1CanonicalStableReleaseProjection | null> {
    const result = await this.dataSource.query(
      `SELECT release_manifest_id AS "releaseManifestId",
              project_id AS "projectId",
              environment_name AS "environmentName",
              metadata->>'releaseRevision' AS "releaseRevision",
              commit_sha AS "commitSha",
              image_uri AS "imageUri",
              task_definition_arn AS "taskDefinitionArn",
              ecs_service_arn AS "ecsServiceArn",
              health_check_path AS "healthCheckPath",
              app_port AS "appPort",
              deployed_by_pipeline_run_id AS "pipelineRunId",
              deployed_at AS "deployedAt"
       FROM project_stable_releases
       WHERE project_id = $1
         AND environment_name = $2
         AND status = 'stable'`,
      [projectId, environmentName],
    );
    return this.oneProjection(result);
  }

  private async canonicalWithinTransaction(
    manager: EntityManager,
    releaseManifestId: string,
  ) {
    const result = await manager.query(
      `${this.canonicalSelect(
        `release.id = $1 AND release.status = 'stable'`,
      )} FOR UPDATE OF release`,
      [releaseManifestId],
    );
    const projection = this.oneProjection(result);
    if (!projection) {
      throw new V1EcsReleaseOutcomeError(
        "ECS_RELEASE_OUTCOME_TRANSITION_CONFLICT",
      );
    }
    return projection;
  }

  private canonicalSelect(where: string) {
    return `SELECT release.id AS "releaseManifestId",
                   release.project_id AS "projectId",
                   release.environment_name AS "environmentName",
                   release.revision::text AS "releaseRevision",
                   release.commit_sha AS "commitSha",
                   (
                     regexp_replace(
                       split_part(release.image_uri, '@', 1),
                       ':[^/:]+$',
                       ''
                     )
                     || '@' || release.image_digest
                   ) AS "imageUri",
                   release.task_definition_arn AS "taskDefinitionArn",
                   COALESCE(
                     release.initial_service_arn,
                     previous.initial_service_arn,
                     infrastructure.terraform_outputs->>'ecs_service_arn'
                   )
                     AS "ecsServiceArn",
                   release.release_spec->'health'->>'path'
                     AS "healthCheckPath",
                   (
                     release.release_spec->'runtime'->>'containerPort'
                   )::integer AS "appPort",
                   release.pipeline_run_id AS "pipelineRunId",
                   release.promoted_at AS "deployedAt"
            FROM release_manifests release
            INNER JOIN infrastructure_manifests infrastructure
              ON infrastructure.id = release.infrastructure_manifest_id
             AND infrastructure.status = 'applied'
            LEFT JOIN release_manifests previous
              ON previous.id = release.previous_stable_manifest_id
             AND previous.project_id = release.project_id
             AND previous.environment_name = release.environment_name
             AND previous.infrastructure_manifest_id = release.infrastructure_manifest_id
            WHERE ${where}`;
  }

  private oneProjection(result: unknown) {
    const rows = this.rows(result) as ProjectionRow[];
    if (rows.length > 1) {
      throw new V1EcsReleaseOutcomeError(
        "ECS_RELEASE_OUTCOME_TRANSITION_CONFLICT",
      );
    }
    const row = rows[0];
    if (!row) return null;
    if (
      !row.releaseManifestId
      || !row.projectId
      || !row.environmentName
      || !/^(?:0|[1-9][0-9]*)$/.test(row.releaseRevision)
      || !row.commitSha
      || !/@sha256:[a-f0-9]{64}$/.test(row.imageUri)
      || !row.taskDefinitionArn
      || !row.healthCheckPath
      || !Number.isInteger(Number(row.appPort))
      || Number(row.appPort) < 1
      || Number(row.appPort) > 65535
      || !(row.deployedAt instanceof Date)
    ) {
      throw new V1EcsReleaseOutcomeError(
        "ECS_RELEASE_OUTCOME_TRANSITION_CONFLICT",
      );
    }
    return {
      ...row,
      appPort: Number(row.appPort),
    };
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
