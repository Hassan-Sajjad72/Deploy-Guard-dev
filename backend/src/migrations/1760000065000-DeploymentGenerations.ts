import { MigrationInterface, QueryRunner } from "typeorm";

export class DeploymentGenerations1760000065000 implements MigrationInterface {
  name = "DeploymentGenerations1760000065000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS project_deployment_generations (
        id uuid PRIMARY KEY,
        project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        environment_name varchar(64) NOT NULL,
        ordinal integer NOT NULL CHECK (ordinal > 0),
        status varchar NOT NULL CHECK (status IN ('active','retiring','retired')),
        created_by_operation_id uuid NULL,
        retired_by_operation_id uuid NULL,
        activated_at timestamptz NULL,
        retired_at timestamptz NULL,
        metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT UQ_project_deployment_generation_ordinal UNIQUE(project_id, environment_name, ordinal)
      )
    `);
    await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS UQ_project_deployment_generation_active ON project_deployment_generations(project_id, environment_name) WHERE status = 'active'`);
    await queryRunner.query(`ALTER TABLE project_pipeline_runs ADD COLUMN IF NOT EXISTS generation_id uuid`);
    await queryRunner.query(`ALTER TABLE project_service_bindings ADD COLUMN IF NOT EXISTS generation_id uuid`);
    await queryRunner.query(`ALTER TABLE project_stable_releases ADD COLUMN IF NOT EXISTS generation_id uuid`);
    await queryRunner.query(`ALTER TABLE project_database_tiers ADD COLUMN IF NOT EXISTS active_generation_id uuid`);

    await queryRunner.query(`
      CREATE TEMP TABLE deployguard_generation_backfill ON COMMIT DROP AS
      WITH operation_scope AS (
        SELECT run.id,
               run.project_id,
               COALESCE(NULLIF(run.metadata #>> '{immutableDispatchInputs,environment_name}', ''), 'dev') AS environment_name,
               run.created_at,
               CASE WHEN run.status::text = 'completed'
                          AND run.current_stage = 'destroyed'
                          AND run.metadata ->> 'deploymentAction' = 'destroy'
                    THEN 1 ELSE 0 END AS verified_destroy
        FROM project_pipeline_runs run
        WHERE run.metadata ->> 'executionEngine' = 'github_actions'
      ), segmented AS (
        SELECT operation_scope.*,
               1 + COALESCE(SUM(verified_destroy) OVER (
                 PARTITION BY project_id, environment_name
                 ORDER BY created_at, id
                 ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
               ), 0) AS ordinal
        FROM operation_scope
      )
      SELECT segmented.*,
             (
               substr(md5(project_id::text || ':' || environment_name || ':' || ordinal::text),1,8) || '-' ||
               substr(md5(project_id::text || ':' || environment_name || ':' || ordinal::text),9,4) || '-4' ||
               substr(md5(project_id::text || ':' || environment_name || ':' || ordinal::text),14,3) || '-8' ||
               substr(md5(project_id::text || ':' || environment_name || ':' || ordinal::text),18,3) || '-' ||
               substr(md5(project_id::text || ':' || environment_name || ':' || ordinal::text),21,12)
             )::uuid AS generation_id
      FROM segmented
    `);
    await queryRunner.query(`
      INSERT INTO project_deployment_generations (
        id, project_id, environment_name, ordinal, status,
        created_by_operation_id, retired_by_operation_id, activated_at, retired_at, metadata
      )
      SELECT generation_id, project_id, environment_name, ordinal,
             CASE WHEN MAX(verified_destroy) = 1 THEN 'retired' ELSE 'active' END,
             (array_agg(id ORDER BY created_at, id))[1],
             (array_agg(id ORDER BY created_at DESC, id DESC) FILTER (WHERE verified_destroy = 1))[1],
             MIN(created_at),
             MAX(created_at) FILTER (WHERE verified_destroy = 1),
             jsonb_build_object('origin', 'historical_backfill')
      FROM deployguard_generation_backfill
      GROUP BY generation_id, project_id, environment_name, ordinal
      ON CONFLICT (id) DO NOTHING
    `);
    await queryRunner.query(`UPDATE project_pipeline_runs run SET generation_id = backfill.generation_id FROM deployguard_generation_backfill backfill WHERE run.id = backfill.id`);
    await queryRunner.query(`UPDATE project_service_bindings binding SET generation_id = run.generation_id FROM project_pipeline_runs run WHERE binding.pipeline_run_id = run.id AND binding.generation_id IS NULL`);
    await queryRunner.query(`UPDATE project_stable_releases release SET generation_id = run.generation_id FROM project_pipeline_runs run WHERE release.deployed_by_pipeline_run_id = run.id AND release.generation_id IS NULL`);
    await queryRunner.query(`
      UPDATE project_database_tiers tier SET active_generation_id = active.id
      FROM project_deployment_generations active
      WHERE active.project_id = tier.project_id AND active.status = 'active'
    `);
    await queryRunner.query(`
      UPDATE project_database_tiers
      SET efs_file_system_id = NULL,
          efs_access_point_id = NULL,
          credentials_secret_arn = NULL,
          database_url_secret_arn = NULL
      WHERE active_generation_id IS NOT NULL
    `);

    await queryRunner.query(`ALTER TABLE project_pipeline_runs ADD CONSTRAINT FK_pipeline_runs_generation FOREIGN KEY (generation_id) REFERENCES project_deployment_generations(id) ON DELETE RESTRICT`);
    await queryRunner.query(`ALTER TABLE project_service_bindings ADD CONSTRAINT FK_service_bindings_generation FOREIGN KEY (generation_id) REFERENCES project_deployment_generations(id) ON DELETE RESTRICT`);
    await queryRunner.query(`ALTER TABLE project_stable_releases ADD CONSTRAINT FK_stable_releases_generation FOREIGN KEY (generation_id) REFERENCES project_deployment_generations(id) ON DELETE RESTRICT`);
    await queryRunner.query(`ALTER TABLE project_database_tiers ADD CONSTRAINT FK_database_tiers_active_generation FOREIGN KEY (active_generation_id) REFERENCES project_deployment_generations(id) ON DELETE SET NULL`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS IDX_pipeline_runs_generation ON project_pipeline_runs(generation_id)`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS IDX_service_bindings_generation ON project_service_bindings(generation_id)`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS IDX_project_stable_releases_generation ON project_stable_releases(generation_id)`);
    await queryRunner.query(`DROP INDEX IF EXISTS UQ_project_stable_release_scope`);
    await queryRunner.query(`CREATE UNIQUE INDEX UQ_project_stable_release_scope ON project_stable_releases(project_id, environment_name, generation_id) WHERE status = 'stable'`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS UQ_project_stable_release_scope`);
    await queryRunner.query(`CREATE UNIQUE INDEX UQ_project_stable_release_scope ON project_stable_releases(project_id, environment_name) WHERE status = 'stable'`);
    await queryRunner.query(`ALTER TABLE project_database_tiers DROP CONSTRAINT IF EXISTS FK_database_tiers_active_generation`);
    await queryRunner.query(`ALTER TABLE project_stable_releases DROP CONSTRAINT IF EXISTS FK_stable_releases_generation`);
    await queryRunner.query(`ALTER TABLE project_service_bindings DROP CONSTRAINT IF EXISTS FK_service_bindings_generation`);
    await queryRunner.query(`ALTER TABLE project_pipeline_runs DROP CONSTRAINT IF EXISTS FK_pipeline_runs_generation`);
    await queryRunner.query(`ALTER TABLE project_database_tiers DROP COLUMN IF EXISTS active_generation_id`);
    await queryRunner.query(`ALTER TABLE project_stable_releases DROP COLUMN IF EXISTS generation_id`);
    await queryRunner.query(`ALTER TABLE project_service_bindings DROP COLUMN IF EXISTS generation_id`);
    await queryRunner.query(`ALTER TABLE project_pipeline_runs DROP COLUMN IF EXISTS generation_id`);
    await queryRunner.query(`DROP TABLE IF EXISTS project_deployment_generations`);
  }
}
