import { MigrationInterface, QueryRunner } from "typeorm";

export class CanonicalEnvironmentResolution1760000063000 implements MigrationInterface {
  name = "CanonicalEnvironmentResolution1760000063000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE project_environment_variables variable
      SET environment = COALESCE(NULLIF(project.environment_name, ''), 'dev')
      FROM projects project
      WHERE project.id = variable.project_id
        AND variable.environment IS DISTINCT FROM COALESCE(NULLIF(project.environment_name, ''), 'dev')
    `);
    await queryRunner.query(`
      UPDATE project_configuration_snapshots snapshot
      SET environment = COALESCE(NULLIF(project.environment_name, ''), 'dev')
      FROM projects project
      WHERE project.id = snapshot.project_id
        AND snapshot.environment IS DISTINCT FROM COALESCE(NULLIF(project.environment_name, ''), 'dev')
    `);
    await queryRunner.query(`ALTER TABLE project_environment_variables ALTER COLUMN environment SET DEFAULT 'dev'`);
    await queryRunner.query(`ALTER TABLE project_configuration_snapshots ALTER COLUMN environment SET DEFAULT 'dev'`);
    await queryRunner.query(`
      DELETE FROM project_environment_variables
      WHERE owner IN ('platform', 'managed_service', 'repository_default')
         OR upper(key) IN (
           'PORT', 'HOST', 'NODE_ENV', 'AWS_REGION', 'AWS_DEFAULT_REGION',
           'DEPLOYGUARD_PROJECT_ID', 'DEPLOYGUARD_ENVIRONMENT', 'DEPLOYGUARD_OPERATION_ID',
           'DEPLOYGUARD_APP_LOG_GROUP', 'DEPLOYGUARD_DATABASE_LOG_GROUP', 'DEPLOYGUARD_DEPLOYMENT_LOG_GROUP'
         )
         OR upper(key) LIKE 'AWS\\_%' ESCAPE '\\'
         OR upper(key) LIKE 'GITHUB\\_%' ESCAPE '\\'
         OR upper(key) LIKE 'ACTIONS\\_%' ESCAPE '\\'
         OR upper(key) LIKE 'TF\\_%' ESCAPE '\\'
         OR upper(key) LIKE 'TF_VAR\\_%' ESCAPE '\\'
         OR upper(key) LIKE 'DEPLOYGUARD\\_%' ESCAPE '\\'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE project_configuration_snapshots ALTER COLUMN environment SET DEFAULT 'production'`);
    await queryRunner.query(`ALTER TABLE project_environment_variables ALTER COLUMN environment SET DEFAULT 'production'`);
  }
}
