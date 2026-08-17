import { MigrationInterface, QueryRunner } from "typeorm";

export class GenerationCandidateRoutingPriority1760000074000 implements MigrationInterface {
  name = "GenerationCandidateRoutingPriority1760000074000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE project_deployment_generations ADD COLUMN IF NOT EXISTS candidate_listener_priority integer`);
    await queryRunner.query(`
      ALTER TABLE project_deployment_generations
      ADD CONSTRAINT CHK_project_deployment_generation_candidate_listener_priority
      CHECK (candidate_listener_priority IS NULL OR candidate_listener_priority BETWEEN 20000 AND 50000)
    `).catch(async (error: unknown) => {
      if (!(error instanceof Error) || !/already exists/i.test(error.message)) throw error;
    });
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS UQ_project_deployment_generation_candidate_listener_priority
      ON project_deployment_generations(candidate_listener_priority)
      WHERE candidate_listener_priority IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS UQ_project_deployment_generation_candidate_listener_priority`);
    await queryRunner.query(`ALTER TABLE project_deployment_generations DROP CONSTRAINT IF EXISTS CHK_project_deployment_generation_candidate_listener_priority`);
    await queryRunner.query(`ALTER TABLE project_deployment_generations DROP COLUMN IF EXISTS candidate_listener_priority`);
  }
}
