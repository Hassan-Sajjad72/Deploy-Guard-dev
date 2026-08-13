import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Quarantine ambiguous legacy identities and remove authority from records
 * whose generation is absent or retired. Historical operation rows remain.
 */
export class GenerationResidueIsolation1760000067000 implements MigrationInterface {
  name = "GenerationResidueIsolation1760000067000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS project_legacy_resource_quarantines (
        id varchar(64) PRIMARY KEY,
        project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        environment_name varchar(64) NOT NULL DEFAULT 'dev',
        resource_type varchar(64) NOT NULL,
        resource_identity text NOT NULL,
        reason varchar(160) NOT NULL,
        status varchar(32) NOT NULL DEFAULT 'quarantined',
        safe_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT UQ_project_legacy_resource_quarantine UNIQUE(project_id, environment_name, resource_type, resource_identity)
      )
    `);
    await queryRunner.query(`ALTER TABLE project_cost_estimates ADD COLUMN IF NOT EXISTS generation_id uuid`);
    await queryRunner.query(`ALTER TABLE project_cost_estimates ADD COLUMN IF NOT EXISTS environment_name varchar NOT NULL DEFAULT 'dev'`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS IDX_project_cost_estimates_generation ON project_cost_estimates(generation_id)`);
    await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS UQ_project_cost_estimates_operation_evidence ON project_cost_estimates(pipeline_run_id) WHERE pipeline_run_id IS NOT NULL AND metadata->>'evidenceContract' = 'deployguard.infracost-operation/v1'`);
    await queryRunner.query(`DO $$ BEGIN
      ALTER TABLE project_cost_estimates ADD CONSTRAINT FK_project_cost_estimates_generation
        FOREIGN KEY (generation_id) REFERENCES project_deployment_generations(id) ON DELETE SET NULL;
    EXCEPTION WHEN duplicate_object THEN NULL; END $$`);

    // Only direct immutable-operation linkage is strong enough to backfill.
    await queryRunner.query(`
      UPDATE project_service_bindings binding
      SET generation_id = run.generation_id
      FROM project_pipeline_runs run
      WHERE binding.pipeline_run_id = run.id
        AND binding.generation_id IS NULL
        AND run.generation_id IS NOT NULL
    `);
    await queryRunner.query(`
      UPDATE project_stable_releases release
      SET generation_id = run.generation_id
      FROM project_pipeline_runs run
      WHERE release.deployed_by_pipeline_run_id = run.id
        AND release.generation_id IS NULL
        AND run.generation_id IS NOT NULL
    `);

    await queryRunner.query(`
      INSERT INTO project_legacy_resource_quarantines
        (id, project_id, environment_name, resource_type, resource_identity, reason, safe_metadata)
      SELECT md5(tier.project_id::text || ':database-tier:' || pointer.identity), tier.project_id, project.environment_name,
             pointer.type, pointer.identity, 'legacy_generation_unproven', '{}'::jsonb
      FROM project_database_tiers tier
      JOIN projects project ON project.id = tier.project_id
      CROSS JOIN LATERAL (VALUES
        ('efs_file_system', tier.efs_file_system_id),
        ('efs_access_point', tier.efs_access_point_id),
        ('credentials_secret', tier.credentials_secret_arn),
        ('database_url_secret', tier.database_url_secret_arn)
      ) pointer(type, identity)
      WHERE pointer.identity IS NOT NULL
        AND (tier.active_generation_id IS NULL OR NOT EXISTS (
          SELECT 1 FROM project_deployment_generations generation
          WHERE generation.id = tier.active_generation_id AND generation.status = 'active'
        ))
      ON CONFLICT (project_id, environment_name, resource_type, resource_identity) DO NOTHING
    `);
    await queryRunner.query(`
      INSERT INTO project_legacy_resource_quarantines
        (id, project_id, environment_name, resource_type, resource_identity, reason, safe_metadata)
      SELECT md5(binding.project_id::text || ':binding:' || binding.id::text), binding.project_id,
             COALESCE(NULLIF(run.metadata #>> '{immutableDispatchInputs,environment_name}', ''), project.environment_name),
             'service_binding', binding.id::text, 'legacy_generation_unproven',
             jsonb_build_object('provider', binding.provider, 'engine', binding.engine)
      FROM project_service_bindings binding
      JOIN projects project ON project.id = binding.project_id
      LEFT JOIN project_pipeline_runs run ON run.id = binding.pipeline_run_id
      WHERE binding.generation_id IS NULL
      ON CONFLICT (project_id, environment_name, resource_type, resource_identity) DO NOTHING
    `);

    await queryRunner.query(`
      UPDATE project_stable_releases release
      SET status = 'superseded',
          metadata = COALESCE(release.metadata, '{}'::jsonb) || jsonb_build_object('authorityRemovedReason', 'generation_not_active')
      WHERE release.status IN ('stable', 'rollback_target')
        AND (release.generation_id IS NULL OR NOT EXISTS (
          SELECT 1 FROM project_deployment_generations generation
          WHERE generation.id = release.generation_id AND generation.status = 'active'
        ))
    `);
    await queryRunner.query(`
      UPDATE project_service_bindings binding
      SET status = 'failed',
          failure_reason = 'Generation retired or identity could not be proven; binding is historical only.',
          host_reference = '',
          username_reference = NULL,
          username_secret_reference = NULL,
          password_secret_reference = NULL,
          database_url_secret_reference = NULL,
          cloud_map_namespace = NULL,
          cloud_map_service_name = NULL,
          cloud_map_service_arn = NULL,
          ecs_database_service_arn = NULL,
          efs_file_system_id = NULL,
          efs_access_point_id = NULL,
          terraform_output_revision = NULL,
          ready_at = NULL,
          applied_at = NULL,
          verified_at = NULL
      WHERE binding.generation_id IS NULL OR EXISTS (
        SELECT 1 FROM project_deployment_generations generation
        WHERE generation.id = binding.generation_id AND generation.status <> 'active'
      )
    `);
    await queryRunner.query(`
      UPDATE project_environment_variables variable
      SET service_binding_id = NULL,
          is_active = false,
          value = '',
          superseded_at = COALESCE(variable.superseded_at, now()),
          superseded_reason = COALESCE(variable.superseded_reason, 'Generation retired; managed binding value scrubbed.')
      FROM project_service_bindings binding
      WHERE variable.service_binding_id = binding.id
        AND (binding.generation_id IS NULL OR EXISTS (
          SELECT 1 FROM project_deployment_generations generation
          WHERE generation.id = binding.generation_id AND generation.status <> 'active'
        ))
    `);
    await queryRunner.query(`
      UPDATE project_configuration_snapshots snapshot
      SET encrypted_secret_payload = NULL,
          secret_references = '{}'::jsonb,
          sanitized_manifest = snapshot.sanitized_manifest || jsonb_build_object('secretPayloadScrubbed', true)
      FROM project_pipeline_runs run
      WHERE snapshot.pipeline_run_id = run.id
        AND run.generation_id IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM project_deployment_generations generation
          WHERE generation.id = run.generation_id AND generation.status <> 'active'
        )
    `);
    await queryRunner.query(`
      UPDATE project_database_tiers tier
      SET active_generation_id = NULL,
          status = 'pending',
          efs_file_system_id = NULL,
          efs_access_point_id = NULL,
          credentials_secret_arn = NULL,
          database_url_secret_arn = NULL,
          backup_plan_id = NULL,
          last_backup_at = NULL,
          last_restore_at = NULL,
          restore_metadata = NULL,
          last_error = NULL
      WHERE tier.active_generation_id IS NULL OR NOT EXISTS (
        SELECT 1 FROM project_deployment_generations generation
        WHERE generation.id = tier.active_generation_id AND generation.status = 'active'
      )
    `);
    await queryRunner.query(`UPDATE project_database_tiers SET backup_enabled = false, backup_plan_id = NULL, last_backup_at = NULL`);
    await queryRunner.query(`
      INSERT INTO project_legacy_resource_quarantines
        (id, project_id, environment_name, resource_type, resource_identity, reason, safe_metadata)
      SELECT md5(storage.project_id::text || ':application-storage:' || pointer.identity), storage.project_id,
             storage.environment_name, pointer.type, pointer.identity, 'application_storage_not_supported_by_active_workflow',
             jsonb_build_object('storageRecordId', storage.id)
      FROM project_persistent_storage storage
      CROSS JOIN LATERAL (VALUES
        ('application_efs_file_system', storage.efs_file_system_id),
        ('application_efs_access_point', storage.efs_access_point_id),
        ('application_efs_security_group', storage.efs_security_group_id),
        ('application_backup_plan', storage.backup_plan_id)
      ) pointer(type, identity)
      WHERE pointer.identity IS NOT NULL
      ON CONFLICT (project_id, environment_name, resource_type, resource_identity) DO NOTHING
    `);
    await queryRunner.query(`
      UPDATE project_persistent_storage
      SET enabled = false,
          user_enabled = false,
          status = 'not_required',
          efs_file_system_id = NULL,
          efs_file_system_arn = NULL,
          efs_dns_name = NULL,
          efs_access_point_id = NULL,
          efs_access_point_arn = NULL,
          efs_security_group_id = NULL,
          mount_target_ids = NULL,
          root_directory = NULL,
          backup_enabled = false,
          backup_vault_name = NULL,
          backup_plan_id = NULL,
          backup_retention_days = NULL,
          ecs_mount_config = NULL,
          metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('authorityRemovedReason', 'application_storage_not_supported_by_active_workflow')
    `);
    await queryRunner.query(`
      INSERT INTO project_legacy_resource_quarantines
        (id, project_id, environment_name, resource_type, resource_identity, reason, safe_metadata)
      SELECT md5(record.project_id::text || ':backup:' || record.id::text), record.project_id, storage.environment_name,
             'backup_recovery_point', COALESCE(record.recovery_point_arn, record.id::text),
             'legacy_backup_not_generation_scoped',
             jsonb_build_object('recordId', record.id, 'status', record.status)
      FROM project_backup_records record
      JOIN project_persistent_storage storage ON storage.id = record.persistent_storage_id
      ON CONFLICT (project_id, environment_name, resource_type, resource_identity) DO NOTHING
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Authority and secret payloads are intentionally not reconstructed.
    await queryRunner.query(`DROP TABLE IF EXISTS project_legacy_resource_quarantines`);
  }
}
