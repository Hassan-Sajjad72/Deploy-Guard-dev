import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Destroy is project extinction. Every table carrying a project or generation
 * identity must therefore follow deletion of that identity instead of keeping
 * an operational tombstone. Existing rows are left untouched until a verified
 * Destroy invokes the extinction transaction.
 */
export class ProjectExtinctionCascade1760000068000 implements MigrationInterface {
  name = "ProjectExtinctionCascade1760000068000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE notification_subscriptions ADD COLUMN IF NOT EXISTS provider_topic_arn varchar`);
    await queryRunner.query(`
      DO $$
      DECLARE item record; constraint_name text;
      BEGIN
        FOR item IN
          SELECT table_schema, table_name
          FROM information_schema.columns
          WHERE table_schema = 'public' AND column_name = 'project_id' AND table_name <> 'projects'
        LOOP
          FOR constraint_name IN
            SELECT tc.constraint_name
            FROM information_schema.table_constraints tc
            JOIN information_schema.key_column_usage kcu
              ON kcu.constraint_schema = tc.constraint_schema AND kcu.constraint_name = tc.constraint_name
            JOIN information_schema.constraint_column_usage ccu
              ON ccu.constraint_schema = tc.constraint_schema AND ccu.constraint_name = tc.constraint_name
            WHERE tc.constraint_type = 'FOREIGN KEY'
              AND tc.table_schema = item.table_schema
              AND tc.table_name = item.table_name
              AND kcu.column_name = 'project_id'
              AND ccu.table_name = 'projects'
          LOOP
            EXECUTE format('ALTER TABLE %I.%I DROP CONSTRAINT %I', item.table_schema, item.table_name, constraint_name);
          END LOOP;
          EXECUTE format(
            'ALTER TABLE %I.%I ADD CONSTRAINT %I FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE NOT VALID',
            item.table_schema, item.table_name, 'fk_ext_project_' || substr(md5(item.table_name), 1, 16)
          );
        END LOOP;
      END $$
    `);
    await queryRunner.query(`
      DO $$
      DECLARE item record; constraint_name text;
      BEGIN
        FOR item IN
          SELECT table_schema, table_name
          FROM information_schema.columns
          WHERE table_schema = 'public' AND column_name = 'generation_id' AND table_name <> 'project_deployment_generations'
        LOOP
          FOR constraint_name IN
            SELECT tc.constraint_name
            FROM information_schema.table_constraints tc
            JOIN information_schema.key_column_usage kcu
              ON kcu.constraint_schema = tc.constraint_schema AND kcu.constraint_name = tc.constraint_name
            JOIN information_schema.constraint_column_usage ccu
              ON ccu.constraint_schema = tc.constraint_schema AND ccu.constraint_name = tc.constraint_name
            WHERE tc.constraint_type = 'FOREIGN KEY'
              AND tc.table_schema = item.table_schema
              AND tc.table_name = item.table_name
              AND kcu.column_name = 'generation_id'
              AND ccu.table_name = 'project_deployment_generations'
          LOOP
            EXECUTE format('ALTER TABLE %I.%I DROP CONSTRAINT %I', item.table_schema, item.table_name, constraint_name);
          END LOOP;
          EXECUTE format(
            'ALTER TABLE %I.%I ADD CONSTRAINT %I FOREIGN KEY (generation_id) REFERENCES project_deployment_generations(id) ON DELETE CASCADE NOT VALID',
            item.table_schema, item.table_name, 'fk_ext_generation_' || substr(md5(item.table_name), 1, 16)
          );
        END LOOP;
      END $$
    `);
    await queryRunner.query(`DO $$ BEGIN
      ALTER TABLE ai_analysis_messages ADD CONSTRAINT fk_ext_ai_messages_session
        FOREIGN KEY (session_id) REFERENCES ai_analysis_sessions(id) ON DELETE CASCADE NOT VALID;
    EXCEPTION WHEN duplicate_object THEN NULL; END $$`);
    await queryRunner.query(`DO $$ BEGIN
      ALTER TABLE ai_analysis_results ADD CONSTRAINT fk_ext_ai_results_session
        FOREIGN KEY (session_id) REFERENCES ai_analysis_sessions(id) ON DELETE CASCADE NOT VALID;
    EXCEPTION WHEN duplicate_object THEN NULL; END $$`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE notification_subscriptions DROP COLUMN IF EXISTS provider_topic_arn`);
    // Project extinction is irreversible. Cascade constraints intentionally
    // remain because restoring tombstone behavior would make deletion unsafe.
  }
}
