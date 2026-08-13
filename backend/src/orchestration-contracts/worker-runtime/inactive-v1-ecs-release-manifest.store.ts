import { DataSource } from "typeorm";
import { InfrastructureManifest } from "../entities/infrastructure-manifest.entity";
import { ReleaseManifest } from "../entities/release-manifest.entity";
import { resolveReleaseServiceArn } from "../release-lane/release-service-lineage";
import {
  V1EcsReleaseManifestPair,
  V1EcsReleaseManifestStore,
  V1EcsReleaseMutationError,
  V1EcsReleaseRevisionIdentity,
} from "./inactive-v1-ecs-release-mutation.types";

export class InactiveV1EcsReleaseManifestStore
implements V1EcsReleaseManifestStore {
  constructor(private readonly dataSource: DataSource) {}

  async loadExact(
    identity: V1EcsReleaseRevisionIdentity,
  ): Promise<V1EcsReleaseManifestPair | null> {
    return this.dataSource.transaction("REPEATABLE READ", async (manager) => {
      const release = await manager.getRepository(ReleaseManifest).findOne({
        where: {
          id: identity.releaseManifestId,
          revision: identity.releaseRevision,
          projectId: identity.projectId,
          environmentName: identity.environmentName,
          infrastructureManifestId: identity.infrastructureManifestId,
        },
      });
      const infrastructure =
        await manager.getRepository(InfrastructureManifest).findOne({
          where: {
            id: identity.infrastructureManifestId,
            revision: identity.infrastructureRevision,
            projectId: identity.projectId,
            environmentName: identity.environmentName,
            status: "applied",
          },
        });
      if (!release || !infrastructure) return null;
      if (!infrastructure.terraformOutputsHash) {
        throw new V1EcsReleaseMutationError(
          "ECS_RELEASE_INFRASTRUCTURE_IDENTITY_INVALID",
        );
      }
      let stableRuntime: V1EcsReleaseManifestPair["stableRuntime"];
      if (!infrastructure.terraformOutputs?.ecs_service_arn
        || !infrastructure.terraformOutputs?.ecs_task_definition_arn) {
        const stable = release.previousStableManifestId
          ? await manager.getRepository(ReleaseManifest).findOne({
            where: {
              id: release.previousStableManifestId,
              projectId: identity.projectId,
              environmentName: identity.environmentName,
              infrastructureManifestId: identity.infrastructureManifestId,
              status: "stable",
            },
          })
          : null;
        const stableServiceArn = stable
          ? await resolveReleaseServiceArn(
            stable,
            (releaseManifestId) => manager.getRepository(ReleaseManifest)
              .findOne({
                where: {
                  id: releaseManifestId,
                  projectId: identity.projectId,
                  environmentName: identity.environmentName,
                  infrastructureManifestId:
                    identity.infrastructureManifestId,
                },
              }),
          )
          : null;
        const serviceName = infrastructure.desiredSpec.ecsFoundation.serviceName;
        if (!stableServiceArn || !stable?.taskDefinitionArn || !serviceName) {
          throw new V1EcsReleaseMutationError("ECS_RELEASE_INFRASTRUCTURE_IDENTITY_INVALID");
        }
        stableRuntime = {
          serviceArn: stableServiceArn,
          taskDefinitionArn: stable.taskDefinitionArn,
          serviceName,
          containerName: "app",
        };
      }
      return {
        release: {
          ...release,
          schemaVersion: 1,
        },
        infrastructure: {
          ...infrastructure,
          schemaVersion: 1,
          status: "applied",
          terraformOutputs: infrastructure.terraformOutputs ?? {},
          terraformOutputsHash: infrastructure.terraformOutputsHash,
        },
        stableRuntime,
      };
    });
  }

  async recordTaskDefinitionReference(input: {
    identity: V1EcsReleaseRevisionIdentity;
    taskDefinitionInputHash: string;
    taskDefinitionArn: string;
    fence: {
      intentId: string;
      leaseId: string;
      workerId: string;
      fencingToken: string;
    };
  }) {
    const result = await this.dataSource.query(
      `UPDATE release_manifests
       SET task_definition_input_hash = $7,
           task_definition_arn = $8,
           status = CASE WHEN status = 'built' THEN 'deploying' ELSE status END,
           deployment_started_at = CASE
             WHEN status = 'built' THEN COALESCE(deployment_started_at, clock_timestamp())
             ELSE deployment_started_at
           END,
           updated_at = clock_timestamp()
       WHERE id = $1
         AND revision = $2::bigint
         AND project_id = $3
         AND environment_name = $4
         AND infrastructure_manifest_id = $5
         AND EXISTS (
           SELECT 1
           FROM infrastructure_manifests infrastructure
           WHERE infrastructure.id = $5
             AND infrastructure.revision = $6::bigint
             AND infrastructure.project_id = $3
             AND infrastructure.environment_name = $4
             AND infrastructure.status = 'applied'
         )
         AND EXISTS (
           SELECT 1
           FROM project_operation_leases lease
           INNER JOIN deployment_intents intent
             ON intent.id = lease.intent_id
           WHERE lease.id = $9
             AND lease.intent_id = $10
             AND lease.project_id = $3
             AND lease.environment_name = $4
             AND lease.owner_worker_id = $11
             AND lease.fencing_token = $12::bigint
             AND lease.status IN ('acquired','heartbeat_active')
             AND lease.expires_at > clock_timestamp()
             AND intent.status = 'running'
         )
         AND (
           task_definition_input_hash IS NULL
           OR task_definition_input_hash = $7
         )
         AND (
           task_definition_arn IS NULL
           OR task_definition_arn = $8
         )
         AND status IN (
           'built','deploying','waiting_for_stability','health_checking','healthy'
         )
       RETURNING task_definition_input_hash AS "taskDefinitionInputHash",
                 task_definition_arn AS "taskDefinitionArn"`,
      [
        input.identity.releaseManifestId,
        input.identity.releaseRevision,
        input.identity.projectId,
        input.identity.environmentName,
        input.identity.infrastructureManifestId,
        input.identity.infrastructureRevision,
        input.taskDefinitionInputHash,
        input.taskDefinitionArn,
        input.fence.leaseId,
        input.fence.intentId,
        input.fence.workerId,
        input.fence.fencingToken,
      ],
    );
    const rows = Array.isArray(result)
      && result.length === 2
      && Array.isArray(result[0])
      ? result[0]
      : result;
    if (!Array.isArray(rows) || rows.length !== 1) {
      throw new V1EcsReleaseMutationError(
        "ECS_RELEASE_TASK_REFERENCE_CONFLICT",
      );
    }
    return rows[0] as {
      taskDefinitionInputHash: string;
      taskDefinitionArn: string;
    };
  }
}
