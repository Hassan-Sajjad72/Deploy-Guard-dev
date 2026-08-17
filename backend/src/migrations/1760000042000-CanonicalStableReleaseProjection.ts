import { MigrationInterface, QueryRunner } from "typeorm";

export class CanonicalStableReleaseProjection1760000042000
implements MigrationInterface {
  name = "CanonicalStableReleaseProjection1760000042000";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      WITH ranked AS (
        SELECT id,
               row_number() OVER (
                 PARTITION BY project_id, environment_name
                 ORDER BY deployed_at DESC, created_at DESC, id DESC
               ) AS position
        FROM project_stable_releases
        WHERE status = 'stable'
      )
      UPDATE project_stable_releases release
      SET status = 'superseded',
          updated_at = clock_timestamp()
      FROM ranked
      WHERE release.id = ranked.id
        AND ranked.position > 1
    `);
    await queryRunner.query(`
      WITH ranked AS (
        SELECT id,
               row_number() OVER (
                 PARTITION BY release_manifest_id
                 ORDER BY updated_at DESC, created_at DESC, id DESC
               ) AS position
        FROM project_stable_releases
        WHERE release_manifest_id IS NOT NULL
      )
      UPDATE project_stable_releases release
      SET release_manifest_id = NULL,
          updated_at = clock_timestamp()
      FROM ranked
      WHERE release.id = ranked.id
        AND ranked.position > 1
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS
        "UQ_project_stable_release_scope"
      ON project_stable_releases (project_id, environment_name)
      WHERE status = 'stable'
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS
        "UQ_project_stable_release_manifest_projection"
      ON project_stable_releases (release_manifest_id)
      WHERE release_manifest_id IS NOT NULL
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP INDEX IF EXISTS
        "UQ_project_stable_release_manifest_projection"
    `);
    await queryRunner.query(`
      DROP INDEX IF EXISTS "UQ_project_stable_release_scope"
    `);
  }
}
