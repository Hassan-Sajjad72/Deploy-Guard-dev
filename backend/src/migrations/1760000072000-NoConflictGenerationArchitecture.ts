import { MigrationInterface, QueryRunner } from "typeorm";

export class NoConflictGenerationArchitecture1760000072000 implements MigrationInterface {
  name = "NoConflictGenerationArchitecture1760000072000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "UQ_project_deployment_generation_active"`);
    await queryRunner.query(`
      DO $$ DECLARE constraint_name text;
      BEGIN
        SELECT c.conname INTO constraint_name
        FROM pg_constraint c
        WHERE c.conrelid = 'project_deployment_generations'::regclass
          AND c.contype = 'c'
          AND pg_get_constraintdef(c.oid) LIKE '%status%active%retiring%retired%'
        LIMIT 1;
        IF constraint_name IS NOT NULL THEN
          EXECUTE format('ALTER TABLE project_deployment_generations DROP CONSTRAINT %I', constraint_name);
        END IF;
      END $$
    `);
    await queryRunner.query(`ALTER TABLE project_deployment_generations ADD COLUMN IF NOT EXISTS terraform_state_key varchar`);
    await queryRunner.query(`ALTER TABLE project_deployment_generations ADD COLUMN IF NOT EXISTS resource_manifest jsonb NOT NULL DEFAULT '{}'::jsonb`);
    await queryRunner.query(`ALTER TABLE project_deployment_generations ADD COLUMN IF NOT EXISTS cleanup_metadata jsonb NOT NULL DEFAULT '{}'::jsonb`);
    await queryRunner.query(`ALTER TABLE project_deployment_generations ADD COLUMN IF NOT EXISTS failed_at timestamptz`);
    await queryRunner.query(`ALTER TABLE project_deployment_generations ADD COLUMN IF NOT EXISTS cleaned_at timestamptz`);
    await queryRunner.query(`
      UPDATE project_deployment_generations
      SET terraform_state_key = 'projects/' || project_id::text || '/' || environment_name || '/' || id::text || '/terraform.tfstate',
          status = CASE status
            WHEN 'active' THEN 'legacy_live'
            WHEN 'retiring' THEN 'cleanup_pending'
            WHEN 'retired' THEN 'legacy_retired'
            ELSE status
          END,
          metadata = metadata || jsonb_build_object('migratedToGenerationModel', 'isolated_generation_v2')
    `);
    await queryRunner.query(`ALTER TABLE project_deployment_generations ALTER COLUMN terraform_state_key SET NOT NULL`);
    await queryRunner.query(`
      ALTER TABLE project_deployment_generations
      ADD CONSTRAINT CHK_project_deployment_generation_status_v2
      CHECK (status IN ('deploying','live','failed','retired','cleanup_pending','cleaned','legacy_live','legacy_retired'))
    `);
    await queryRunner.query(`CREATE UNIQUE INDEX UQ_project_deployment_generation_live ON project_deployment_generations(project_id, environment_name) WHERE status IN ('live','legacy_live')`);
    await queryRunner.query(`CREATE UNIQUE INDEX UQ_project_deployment_generation_candidate ON project_deployment_generations(project_id, environment_name) WHERE status = 'deploying'`);
    await queryRunner.query(`CREATE UNIQUE INDEX UQ_project_deployment_generation_state_key ON project_deployment_generations(terraform_state_key)`);

    await queryRunner.query(`
      CREATE TABLE project_environment_routes (
        id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        environment_name varchar(64) NOT NULL,
        listener_priority integer NOT NULL CHECK (listener_priority BETWEEN 1000 AND 19999),
        listener_rule_arn varchar NULL,
        live_generation_id uuid NULL REFERENCES project_deployment_generations(id) ON DELETE SET NULL,
        candidate_generation_id uuid NULL REFERENCES project_deployment_generations(id) ON DELETE SET NULL,
        metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT UQ_project_environment_route_scope UNIQUE(project_id, environment_name),
        CONSTRAINT UQ_project_environment_route_priority UNIQUE(listener_priority),
        CONSTRAINT CHK_project_environment_route_distinct_generations CHECK (live_generation_id IS NULL OR candidate_generation_id IS NULL OR live_generation_id <> candidate_generation_id)
      )
    `);
    await queryRunner.query(`CREATE INDEX IDX_project_environment_routes_project ON project_environment_routes(project_id)`);
    await queryRunner.query(`
      INSERT INTO project_environment_routes(project_id, environment_name, listener_priority, live_generation_id, metadata)
      SELECT project_id, environment_name, 999 + row_number() OVER (ORDER BY project_id, environment_name), id,
             jsonb_build_object('allocation', 'legacy_migration_v1')
      FROM project_deployment_generations
      WHERE status IN ('live','legacy_live')
      ON CONFLICT (project_id, environment_name) DO NOTHING
    `);
    await queryRunner.query(`DROP INDEX IF EXISTS UQ_project_stable_release_scope`);
    await queryRunner.query(`CREATE UNIQUE INDEX UQ_project_stable_release_scope ON project_stable_releases(project_id, environment_name) WHERE status = 'stable'`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS UQ_project_stable_release_scope`);
    await queryRunner.query(`CREATE UNIQUE INDEX UQ_project_stable_release_scope ON project_stable_releases(project_id, environment_name, generation_id) WHERE status = 'stable'`);
    await queryRunner.query(`DROP TABLE IF EXISTS project_environment_routes`);
    await queryRunner.query(`DROP INDEX IF EXISTS UQ_project_deployment_generation_state_key`);
    await queryRunner.query(`DROP INDEX IF EXISTS UQ_project_deployment_generation_candidate`);
    await queryRunner.query(`DROP INDEX IF EXISTS UQ_project_deployment_generation_live`);
    await queryRunner.query(`ALTER TABLE project_deployment_generations DROP CONSTRAINT IF EXISTS CHK_project_deployment_generation_status_v2`);
    await queryRunner.query(`UPDATE project_deployment_generations SET status = CASE WHEN status IN ('live','legacy_live','deploying','failed') THEN 'active' WHEN status = 'cleanup_pending' THEN 'retiring' ELSE 'retired' END`);
    await queryRunner.query(`ALTER TABLE project_deployment_generations ADD CONSTRAINT CHK_project_deployment_generation_status CHECK (status IN ('active','retiring','retired'))`);
    await queryRunner.query(`CREATE UNIQUE INDEX UQ_project_deployment_generation_active ON project_deployment_generations(project_id, environment_name) WHERE status = 'active'`);
    await queryRunner.query(`ALTER TABLE project_deployment_generations DROP COLUMN IF EXISTS cleaned_at`);
    await queryRunner.query(`ALTER TABLE project_deployment_generations DROP COLUMN IF EXISTS failed_at`);
    await queryRunner.query(`ALTER TABLE project_deployment_generations DROP COLUMN IF EXISTS cleanup_metadata`);
    await queryRunner.query(`ALTER TABLE project_deployment_generations DROP COLUMN IF EXISTS resource_manifest`);
    await queryRunner.query(`ALTER TABLE project_deployment_generations DROP COLUMN IF EXISTS terraform_state_key`);
  }
}
