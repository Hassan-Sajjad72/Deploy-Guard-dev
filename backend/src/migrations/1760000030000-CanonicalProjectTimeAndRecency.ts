import { MigrationInterface, QueryRunner } from "typeorm";

export class CanonicalProjectTimeAndRecency1760000030000 implements MigrationInterface {
  name = "CanonicalProjectTimeAndRecency1760000030000";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "github_repository_id" varchar`);
    await queryRunner.query(`ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "environment_name" varchar NOT NULL DEFAULT 'dev'`);
    await queryRunner.query(`ALTER TABLE "project_pipeline_runs" ADD COLUMN IF NOT EXISTS "current_stage_started_at" timestamptz`);
    await queryRunner.query(`ALTER TABLE "project_pipeline_events" ADD COLUMN IF NOT EXISTS "occurred_at" timestamptz NOT NULL DEFAULT now()`);
    await queryRunner.query(`ALTER TABLE "project_pipeline_events" ADD COLUMN IF NOT EXISTS "ingested_at" timestamptz NOT NULL DEFAULT now()`);
    await queryRunner.query(`ALTER TABLE "project_pipeline_events" ADD COLUMN IF NOT EXISTS "duration_ms" bigint`);
    await queryRunner.query(`ALTER TABLE "project_pipeline_events" ADD COLUMN IF NOT EXISTS "source" varchar NOT NULL DEFAULT 'pipeline_worker'`);
    await queryRunner.query(`ALTER TABLE "project_pipeline_events" ADD COLUMN IF NOT EXISTS "sequence_number" integer NOT NULL DEFAULT 0`);
    await queryRunner.query(`UPDATE "project_pipeline_events" SET "occurred_at"="created_at", "ingested_at"="created_at"`);
    await queryRunner.query(`UPDATE "project_pipeline_events" SET "source" = CASE WHEN "stage" ILIKE '%terraform%' OR "stage" ILIKE '%state_lock%' THEN 'terraform' WHEN "stage" ILIKE '%ecs%' THEN 'aws_ecs' WHEN "stage" ILIKE '%alb%' OR "stage" ILIKE '%health%' THEN 'aws_alb' WHEN "stage" ILIKE '%cleanup%' THEN 'cleanup' ELSE 'pipeline_worker' END`);
    await queryRunner.query(`WITH ranked AS (SELECT id, row_number() OVER (PARTITION BY pipeline_run_id ORDER BY occurred_at, created_at, id)::integer AS seq FROM project_pipeline_events) UPDATE project_pipeline_events event SET sequence_number=ranked.seq FROM ranked WHERE event.id=ranked.id`);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "project_user_activity" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(), "user_id" integer NOT NULL, "project_id" uuid NOT NULL,
        "last_viewed_at" timestamptz, "last_user_action_at" timestamptz, "last_meaningful_activity_at" timestamptz,
        "last_pipeline_activity_at" timestamptz, "last_route" varchar, "last_section" varchar, "last_action_type" varchar,
        "pinned" boolean NOT NULL DEFAULT false, "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_project_user_activity" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_project_user_activity_user_project" UNIQUE ("user_id", "project_id"),
        CONSTRAINT "FK_project_user_activity_user" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_project_user_activity_project" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_project_user_activity_user_meaningful" ON "project_user_activity" ("user_id", "last_meaningful_activity_at" DESC)`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_project_user_activity_user_viewed" ON "project_user_activity" ("user_id", "last_viewed_at" DESC)`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_projects_github_repository_id" ON "projects" ("github_repository_id")`);
    await queryRunner.query(`
      WITH duplicates AS (
        SELECT id, row_number() OVER (PARTITION BY owner_user_id, lower(repository_full_name), target_branch, environment_name ORDER BY created_at, id) AS duplicate_number
        FROM projects WHERE archived_at IS NULL AND status::text <> 'archived'
      )
      UPDATE projects project SET environment_name='legacy-' || substring(project.id::text, 1, 8)
      FROM duplicates WHERE project.id=duplicates.id AND duplicates.duplicate_number > 1
    `);
    await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "UQ_active_project_repository_branch_environment" ON "projects" ("owner_user_id", lower("repository_full_name"), "target_branch", "environment_name") WHERE "archived_at" IS NULL`);
    await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "UQ_active_project_github_branch_environment" ON "projects" ("owner_user_id", "github_repository_id", "target_branch", "environment_name") WHERE "github_repository_id" IS NOT NULL AND "archived_at" IS NULL`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_pipeline_events_canonical_order" ON "project_pipeline_events" ("pipeline_run_id", "occurred_at", "sequence_number")`);
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION deployguard_set_pipeline_event_sequence() RETURNS trigger AS $$
      BEGIN
        IF NEW.sequence_number IS NULL OR NEW.sequence_number <= 0 THEN
          PERFORM pg_advisory_xact_lock(hashtext(NEW.pipeline_run_id::text));
          SELECT COALESCE(MAX(sequence_number), 0) + 1 INTO NEW.sequence_number
          FROM project_pipeline_events WHERE pipeline_run_id=NEW.pipeline_run_id;
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    await queryRunner.query(`DROP TRIGGER IF EXISTS trg_deployguard_pipeline_event_sequence ON "project_pipeline_events"`);
    await queryRunner.query(`CREATE TRIGGER trg_deployguard_pipeline_event_sequence BEFORE INSERT ON "project_pipeline_events" FOR EACH ROW EXECUTE FUNCTION deployguard_set_pipeline_event_sequence()`);
    await queryRunner.query(`
      INSERT INTO project_user_activity (user_id, project_id, last_user_action_at, last_meaningful_activity_at, last_pipeline_activity_at, last_route, last_section, last_action_type, updated_at)
      SELECT p.owner_user_id, p.id, p.created_at,
        GREATEST(p.created_at, COALESCE(latest.pipeline_at, p.created_at)), latest.pipeline_at,
        '/projects/' || p.id, 'overview', CASE WHEN latest.pipeline_at IS NULL THEN 'project_created' ELSE 'pipeline_activity_migrated' END, now()
      FROM projects p
      LEFT JOIN LATERAL (
        SELECT MAX(COALESCE(r.failed_at, r.completed_at, r.started_at, r.created_at)) AS pipeline_at
        FROM project_pipeline_runs r WHERE r.project_id=p.id AND r.triggered_by_user_id=p.owner_user_id
      ) latest ON true
      ON CONFLICT (user_id, project_id) DO NOTHING
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TRIGGER IF EXISTS trg_deployguard_pipeline_event_sequence ON "project_pipeline_events"`);
    await queryRunner.query(`DROP FUNCTION IF EXISTS deployguard_set_pipeline_event_sequence()`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_pipeline_events_canonical_order"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "UQ_active_project_github_branch_environment"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "UQ_active_project_repository_branch_environment"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_projects_github_repository_id"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "project_user_activity"`);
    await queryRunner.query(`ALTER TABLE "project_pipeline_events" DROP COLUMN IF EXISTS "sequence_number"`);
    await queryRunner.query(`ALTER TABLE "project_pipeline_events" DROP COLUMN IF EXISTS "source"`);
    await queryRunner.query(`ALTER TABLE "project_pipeline_events" DROP COLUMN IF EXISTS "duration_ms"`);
    await queryRunner.query(`ALTER TABLE "project_pipeline_events" DROP COLUMN IF EXISTS "ingested_at"`);
    await queryRunner.query(`ALTER TABLE "project_pipeline_events" DROP COLUMN IF EXISTS "occurred_at"`);
    await queryRunner.query(`ALTER TABLE "project_pipeline_runs" DROP COLUMN IF EXISTS "current_stage_started_at"`);
    await queryRunner.query(`ALTER TABLE "projects" DROP COLUMN IF EXISTS "environment_name"`);
    await queryRunner.query(`ALTER TABLE "projects" DROP COLUMN IF EXISTS "github_repository_id"`);
  }
}
