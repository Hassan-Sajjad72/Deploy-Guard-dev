import { EntityManager, In } from "typeorm";
import { assertCanonicalDestroyCoverage } from "./aws-resource-ownership-coverage";
import { AWS_RESOURCE_OWNERSHIP_SOURCE, DestroyOwnership, DestroyOwnershipIncompleteError, freezeDestroyOwnership, OwnershipScope } from "./aws-resource-ownership";
import { ProjectDeploymentGeneration } from "./project-deployment-generation.entity";
import { ProjectPipelineEvent } from "./project-pipeline-event.entity";
import { ProjectPipelineRun } from "./project-pipeline-run.entity";
import { ProjectGenerationServiceRevision } from "./project-generation-service-revision.entity";
import { ProjectServiceRuntimeConfigRevision } from "./project-service-runtime-config-revision.entity";
import { RUNTIME_SECRET_OWNERSHIP_SOURCE } from "./runtime-secret-ownership";

/** Read the complete durable authority, never an artifact-selected subset.
 * Callers hold the canonical project configuration lock for this snapshot.
 */
export async function loadDestroyOwnership(
  manager: EntityManager,
  scope: OwnershipScope,
  stateBucket: string,
  generations?: ProjectDeploymentGeneration[],
): Promise<DestroyOwnership> {
  const retainedGenerations = generations ?? await manager.getRepository(ProjectDeploymentGeneration).find({
    where: { projectId: scope.projectId }, take: 1001,
  });
  const history = await manager.getRepository(ProjectPipelineRun).find({ where: { projectId: scope.projectId }, take: 1001 });
  if (!retainedGenerations.length || retainedGenerations.length > 1000 || history.length > 1000
    || retainedGenerations.some((generation) => generation.projectId !== scope.projectId || generation.environmentName !== scope.environmentName)) throw new DestroyOwnershipIncompleteError();
  // Finalization deletes the WHOLE project. A different or malformed historical
  // environment cannot be silently excluded and have its evidence cascaded away.
  // Cross-environment cleanup is not a supported second lifecycle here.
  if (history.some((run) => {
    const environment = (run.metadata?.immutableDispatchInputs as Record<string, unknown> | undefined)?.environment_name;
    return environment !== undefined && environment !== scope.environmentName;
  })) throw new DestroyOwnershipIncompleteError();
  const operations = history.filter((run) => run.metadata?.deploymentAction !== "destroy");
  if (retainedGenerations.some((generation) => !generation.createdByOperationId
    || !operations.some((run) => run.id === generation.createdByOperationId))) throw new DestroyOwnershipIncompleteError();
  const events = await manager.getRepository(ProjectPipelineEvent).find({
    where: { projectId: scope.projectId, source: In([AWS_RESOURCE_OWNERSHIP_SOURCE, RUNTIME_SECRET_OWNERSHIP_SOURCE]) }, take: 1001,
  });
  if (events.length > 1000) throw new DestroyOwnershipIncompleteError();
  const ownership = freezeDestroyOwnership({ ...scope, generationIds: retainedGenerations.map((generation) => generation.id).sort() }, operations, events, stateBucket);
  const revisions = await manager.getRepository(ProjectGenerationServiceRevision).find({
    where: { generationId: In(retainedGenerations.map((generation) => generation.id)) }, take: 1001,
  });
  const configurations = await manager.getRepository(ProjectServiceRuntimeConfigRevision).find({
    where: { projectId: scope.projectId }, take: 1001,
  });
  const runtimeEvents = events.filter((event) => event.source === RUNTIME_SECRET_OWNERSHIP_SOURCE);
  assertCanonicalDestroyCoverage(ownership, retainedGenerations, revisions, configurations, runtimeEvents);
  return ownership;
}
