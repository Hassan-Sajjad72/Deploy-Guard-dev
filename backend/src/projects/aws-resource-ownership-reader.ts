import { EntityManager } from "typeorm";
import { AWS_RESOURCE_OWNERSHIP_SOURCE, DestroyOwnership, DestroyOwnershipIncompleteError, freezeDestroyOwnership, OwnershipScope } from "./aws-resource-ownership";
import { ProjectDeploymentGeneration } from "./project-deployment-generation.entity";
import { ProjectPipelineEvent } from "./project-pipeline-event.entity";
import { ProjectPipelineRun } from "./project-pipeline-run.entity";

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
    where: { projectId: scope.projectId, environmentName: scope.environmentName }, take: 1001,
  });
  const history = await manager.getRepository(ProjectPipelineRun).find({ where: { projectId: scope.projectId }, take: 1001 });
  if (!retainedGenerations.length || retainedGenerations.length > 1000 || history.length > 1000) throw new DestroyOwnershipIncompleteError();
  // Unknown historical environments remain in scope and fail closed. Only an
  // explicit frozen other environment can exclude an operation.
  const operations = history.filter((run) => run.metadata?.deploymentAction !== "destroy"
    && ((run.metadata?.immutableDispatchInputs as Record<string, unknown> | undefined)?.environment_name === undefined
      || (run.metadata?.immutableDispatchInputs as Record<string, unknown>)?.environment_name === scope.environmentName));
  if (retainedGenerations.some((generation) => !generation.createdByOperationId
    || !operations.some((run) => run.id === generation.createdByOperationId))) throw new DestroyOwnershipIncompleteError();
  const events = await manager.getRepository(ProjectPipelineEvent).find({
    where: { projectId: scope.projectId, source: AWS_RESOURCE_OWNERSHIP_SOURCE }, take: 1001,
  });
  if (events.length > 1000) throw new DestroyOwnershipIncompleteError();
  return freezeDestroyOwnership({ ...scope, generationIds: retainedGenerations.map((generation) => generation.id).sort() }, operations, events, stateBucket);
}
