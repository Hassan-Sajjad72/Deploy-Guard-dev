import { MigrationInterface, QueryRunner } from "typeorm";

/** Remove pre-contract orphan residue, then make extinction ownership enforceable. */
export class ValidateProjectExtinctionOwnership1760000069000 implements MigrationInterface {
  name = "ValidateProjectExtinctionOwnership1760000069000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$ DECLARE item record;
      BEGIN
        FOR item IN
          SELECT table_schema, table_name FROM information_schema.columns
          WHERE table_schema='public' AND column_name='project_id' AND table_name <> 'projects'
        LOOP
          EXECUTE format('DELETE FROM %I.%I child WHERE project_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM projects owner WHERE owner.id = child.project_id)', item.table_schema, item.table_name);
        END LOOP;
        FOR item IN
          SELECT table_schema, table_name FROM information_schema.columns
          WHERE table_schema='public' AND column_name='generation_id' AND table_name <> 'project_deployment_generations'
        LOOP
          EXECUTE format('DELETE FROM %I.%I child WHERE generation_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM project_deployment_generations owner WHERE owner.id = child.generation_id)', item.table_schema, item.table_name);
        END LOOP;
        DELETE FROM ai_analysis_messages child WHERE NOT EXISTS (SELECT 1 FROM ai_analysis_sessions owner WHERE owner.id = child.session_id);
        DELETE FROM ai_analysis_results child WHERE NOT EXISTS (SELECT 1 FROM ai_analysis_sessions owner WHERE owner.id = child.session_id);
        FOR item IN
          SELECT n.nspname AS table_schema, c.relname AS table_name, con.conname AS constraint_name
          FROM pg_constraint con JOIN pg_class c ON c.oid=con.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace
          WHERE n.nspname='public' AND con.contype='f' AND con.conname LIKE 'fk_ext_%' AND NOT con.convalidated
        LOOP
          EXECUTE format('ALTER TABLE %I.%I VALIDATE CONSTRAINT %I', item.table_schema, item.table_name, item.constraint_name);
        END LOOP;
      END $$
    `);
  }

  public async down(): Promise<void> {
    // Deleted orphan residue has no authoritative owner and cannot be restored.
  }
}
