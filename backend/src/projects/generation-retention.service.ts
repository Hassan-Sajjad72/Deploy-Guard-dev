import { Injectable } from "@nestjs/common";
import { DataSource } from "typeorm";

const CONFIGURATION_SECRET_WINDOW = 20;

@Injectable()
export class GenerationRetentionService {
  constructor(private readonly dataSource: DataSource) {}

  async apply(projectId: string, generationId: string) {
    await this.dataSource.transaction(async (manager) => {
      await manager.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`generation-retention:${projectId}:${generationId}`]);
      await manager.query(`
        WITH recent AS (
          SELECT id AS operation_id FROM project_pipeline_runs
          WHERE project_id = $1 AND generation_id = $2
          ORDER BY created_at DESC
          LIMIT $3
        ), preserved AS (
          SELECT deployed_by_pipeline_run_id AS operation_id
          FROM project_stable_releases
          WHERE project_id = $1 AND generation_id = $2 AND status IN ('stable', 'rollback_target')
          UNION
          SELECT id AS operation_id FROM project_pipeline_runs
          WHERE project_id = $1 AND generation_id = $2 AND status IN ('queued', 'running')
          UNION
          SELECT operation_id FROM recent
        ), old_snapshots AS (
          SELECT snapshot.id
          FROM project_configuration_snapshots snapshot
          JOIN project_pipeline_runs run ON run.id = snapshot.pipeline_run_id
          WHERE run.project_id = $1 AND run.generation_id = $2
            AND run.id NOT IN (SELECT operation_id FROM preserved WHERE operation_id IS NOT NULL)
        )
        UPDATE project_configuration_snapshots snapshot
        SET encrypted_secret_payload = NULL,
            secret_references = '{}'::jsonb,
            sanitized_manifest = snapshot.sanitized_manifest || jsonb_build_object('secretPayloadScrubbedByRetention', true)
        WHERE snapshot.id IN (SELECT id FROM old_snapshots)
      `, [projectId, generationId, CONFIGURATION_SECRET_WINDOW]);
    });
  }
}
