import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Older verified one-service releases persisted their immutable image/service
 * revision before Terraform's runtime fields were copied into that revision.
 * Backfill only that unambiguous one-revision shape. Multi-service releases
 * are never inferred from project-level scalar projections.
 */
export class BackfillCanonicalServiceRuntimeIdentity1787356816000 implements MigrationInterface {
  name = "BackfillCanonicalServiceRuntimeIdentity1787356816000";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      WITH one_service_generation AS (
        SELECT generation_id
        FROM project_generation_service_revisions
        GROUP BY generation_id
        HAVING count(*) = 1
      )
      UPDATE project_generation_service_revisions revision
      SET runtime_identity = coalesce(revision.runtime_identity, '{}'::jsonb) || jsonb_strip_nulls(jsonb_build_object(
        'serviceId', revision.service_id,
        'serviceName', revision.service_name,
        'serviceDirectory', revision.service_directory,
        'imageUri', revision.image_uri,
        'imageDigest', revision.image_digest,
        'runtimeConfigRevisionId', revision.runtime_config_revision_id,
        'publicUrl', coalesce(revision.runtime_identity->>'publicUrl', generation.resource_manifest->>'publicUrl'),
        'region', coalesce(revision.runtime_identity->>'region', generation.resource_manifest->>'region'),
        'ecsClusterArn', coalesce(revision.runtime_identity->>'ecsClusterArn', generation.resource_manifest->>'ecsClusterArn'),
        'ecsClusterName', coalesce(revision.runtime_identity->>'ecsClusterName', generation.resource_manifest->>'ecsClusterName'),
        'ecsServiceArn', coalesce(revision.runtime_identity->>'ecsServiceArn', generation.resource_manifest->>'ecsServiceArn'),
        'ecsServiceName', coalesce(revision.runtime_identity->>'ecsServiceName', generation.resource_manifest->>'ecsServiceName'),
        'taskDefinitionArn', coalesce(revision.runtime_identity->>'taskDefinitionArn', generation.resource_manifest->>'taskDefinitionArn'),
        'albArn', coalesce(revision.runtime_identity->>'albArn', generation.resource_manifest->>'albArn'),
        'albName', coalesce(revision.runtime_identity->>'albName', generation.resource_manifest->>'albName'),
        'targetGroupArn', coalesce(revision.runtime_identity->>'targetGroupArn', generation.resource_manifest->>'targetGroupArn'),
        'targetGroupName', coalesce(revision.runtime_identity->>'targetGroupName', generation.resource_manifest->>'targetGroupName'),
        'cloudWatchLogGroupName', coalesce(revision.runtime_identity->>'cloudWatchLogGroupName', generation.resource_manifest->>'cloudWatchLogGroupName'),
        'applicationContainerName', coalesce(revision.runtime_identity->>'applicationContainerName', generation.resource_manifest->>'applicationContainerName')
      ))
      FROM project_deployment_generations generation
      JOIN one_service_generation one_service ON one_service.generation_id = generation.id
      WHERE revision.generation_id = generation.id
    `);
  }

  async down(): Promise<void> {
    // Backfilled values are immutable runtime identity, so rollback must not
    // erase verified operational history.
  }
}
