import { MigrationInterface, QueryRunner } from "typeorm";

export class CreateProjectDeploymentContracts1760000018000 implements MigrationInterface {
  name = "CreateProjectDeploymentContracts1760000018000";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "project_deployment_contracts" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "project_id" uuid NOT NULL,
        "detection_profile_id" uuid,
        "repository_full_name" varchar,
        "branch" varchar NOT NULL,
        "commit_sha" varchar,
        "app_root" varchar NOT NULL DEFAULT '.',
        "language" varchar,
        "framework" varchar,
        "runtime_type" varchar,
        "package_manager" varchar,
        "dependency_manifest" varchar,
        "lockfile" varchar,
        "node_version" varchar,
        "python_version" varchar,
        "install_command" varchar,
        "build_command" varchar,
        "start_command" varchar,
        "output_directory" varchar,
        "port" integer,
        "port_source" varchar,
        "binds_to_port_env" boolean NOT NULL DEFAULT false,
        "bind_host" varchar,
        "health_path" varchar NOT NULL DEFAULT '/',
        "required_env_vars" jsonb NOT NULL DEFAULT '[]'::jsonb,
        "optional_env_vars" jsonb NOT NULL DEFAULT '[]'::jsonb,
        "build_time_env_vars" jsonb NOT NULL DEFAULT '[]'::jsonb,
        "runtime_env_vars" jsonb NOT NULL DEFAULT '[]'::jsonb,
        "secret_env_vars" jsonb NOT NULL DEFAULT '[]'::jsonb,
        "missing_env_vars" jsonb NOT NULL DEFAULT '[]'::jsonb,
        "database_required" boolean NOT NULL DEFAULT false,
        "persistent_storage_required" boolean NOT NULL DEFAULT false,
        "private_registry_required" boolean NOT NULL DEFAULT false,
        "docker_strategy" varchar,
        "docker_template" varchar,
        "ecs_plan" jsonb NOT NULL,
        "deployable" boolean NOT NULL DEFAULT false,
        "blockers" jsonb NOT NULL DEFAULT '[]'::jsonb,
        "warnings" jsonb NOT NULL DEFAULT '[]'::jsonb,
        "confidence" varchar NOT NULL DEFAULT 'low',
        "generated_at" timestamptz NOT NULL,
        "detection_source_commit" varchar,
        "overrides_hash" varchar NOT NULL,
        "contract_hash" varchar NOT NULL,
        "generated_dockerfile" text,
        "invalidated_reason" varchar,
        "invalidated_at" timestamptz,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_project_deployment_contracts" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_project_deployment_contracts_project" UNIQUE ("project_id"),
        CONSTRAINT "FK_project_deployment_contracts_project" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_project_deployment_contracts_detection" FOREIGN KEY ("detection_profile_id") REFERENCES "project_detection_profiles"("id") ON DELETE SET NULL
      )
    `);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_project_deployment_contracts_project_id" ON "project_deployment_contracts" ("project_id")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_project_deployment_contracts_commit" ON "project_deployment_contracts" ("project_id", "detection_source_commit")`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "project_deployment_contracts"`);
  }
}
