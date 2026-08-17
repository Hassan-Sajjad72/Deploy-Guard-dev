import { MigrationInterface, QueryRunner } from "typeorm";

export class AuthoritativeBuildPlan1760000064000 implements MigrationInterface {
  name = "AuthoritativeBuildPlan1760000064000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE project_deployment_contracts ADD COLUMN IF NOT EXISTS build_plan jsonb`);
    await queryRunner.query(`UPDATE project_deployment_contracts SET deployable = false, invalidated_reason = COALESCE(invalidated_reason, 'Repository analysis changed. Run Detect Stack again before deploying.') WHERE build_plan IS NULL`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE project_deployment_contracts DROP COLUMN IF EXISTS build_plan`);
  }
}
