import { assertDestroyOwnership, DestroyOwnership, DestroyOwnershipIncompleteError, OwnedAwsResource } from "./aws-resource-ownership";
import type { ProjectDeploymentGeneration } from "./project-deployment-generation.entity";
import type { ProjectGenerationServiceRevision } from "./project-generation-service-revision.entity";
import type { ProjectPipelineEvent } from "./project-pipeline-event.entity";
import type { ProjectServiceRuntimeConfigRevision } from "./project-service-runtime-config-revision.entity";
import { RUNTIME_SECRET_OWNERSHIP_SOURCE, RuntimeSecretOwnershipEvent, RuntimeSecretOwnershipPersistenceError, runtimeSecretOwnershipRecord } from "./runtime-secret-ownership";

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
function incomplete(): never { throw new DestroyOwnershipIncompleteError(); }

/** A journal's completeness declaration cannot erase independently retained
 * canonical identities. This checks a minimum, NOT the full Terraform inventory.
 * Missing resources are rejected, never invented or added to deletion authority.
 */
export function assertCanonicalDestroyCoverage(
  ownership: DestroyOwnership,
  generations: Array<Pick<ProjectDeploymentGeneration, "id" | "createdByOperationId">>,
  revisions: ProjectGenerationServiceRevision[],
  configurations: ProjectServiceRuntimeConfigRevision[],
  runtimeEvents: Array<Pick<ProjectPipelineEvent, "pipelineRunId" | "projectId" | "source" | "metadata">>,
) {
  assertDestroyOwnership(ownership);
  if (revisions.length > 1000 || configurations.length > 1000 || runtimeEvents.length > 1000) incomplete();
  const scope = ownership.manifest.scope;
  const operations = new Set(ownership.receipts.map((receipt) => receipt.operationId));
  const resources = new Map(ownership.manifest.resources.map((resource) => [JSON.stringify([resource.type, resource.id]), resource]));
  const need = (type: OwnedAwsResource["type"], id: unknown, parent?: string) => {
    if (typeof id !== "string" || !id) incomplete();
    const resource = resources.get(JSON.stringify([type, id]));
    if (!resource || (parent !== undefined && resource.parent !== parent)) incomplete();
  };
  const ecsPrefix = `arn:aws:ecs:${scope.region}:${scope.accountId}:`;
  const service = (id: unknown, cluster?: unknown) => {
    if (typeof id !== "string" || !id.startsWith(ecsPrefix)) incomplete();
    const longArn = id.slice(ecsPrefix.length).match(/^service\/([A-Za-z0-9_-]{1,255})\/[A-Za-z0-9_-]{1,255}$/);
    if (!longArn && !/^service\/[A-Za-z0-9_-]{1,255}$/.test(id.slice(ecsPrefix.length))) incomplete();
    const parent = longArn ? `${ecsPrefix}cluster/${longArn[1]}` : cluster;
    if (typeof parent !== "string" || !parent.startsWith(ecsPrefix) || !/^cluster\/[A-Za-z0-9_-]{1,255}$/.test(parent.slice(ecsPrefix.length))
      || (cluster !== undefined && cluster !== parent)) incomplete();
    need("aws_ecs_cluster", parent);
    need("aws_ecs_service", id, parent);
  };

  const intents = new Set<string>();
  const owned = new Set<string>();
  const ownedSecrets = new Set<string>();
  for (const row of runtimeEvents) {
    const evidence = row.metadata?.evidence;
    if (row.source !== RUNTIME_SECRET_OWNERSHIP_SOURCE || row.projectId !== scope.projectId || !operations.has(row.pipelineRunId)
      || !object(evidence) || evidence.contractVersion !== "deployguard.runtime-secret-ownership/v1"
      || Object.keys(evidence).some((key) => !["contractVersion", "projectId", "operationId", "serviceId", "environmentName", "accountId", "region", "phase", "secretName", "versionToken", "secretArn"].includes(key))
      || evidence.operationId !== row.pipelineRunId || evidence.accountId !== scope.accountId || evidence.region !== scope.region) incomplete();
    // Reuse the production collector's strict scope/identifier validation and
    // JSONB-stable receipt, rather than a second runtime-secret schema.
    let retained: ReturnType<typeof runtimeSecretOwnershipRecord>;
    try {
      retained = runtimeSecretOwnershipRecord({ phase: evidence.phase, projectId: evidence.projectId, operationId: evidence.operationId,
        serviceId: evidence.serviceId, environmentName: evidence.environmentName, secretName: evidence.secretName, versionToken: evidence.versionToken,
        ...(evidence.secretArn === undefined ? {} : { secretArn: evidence.secretArn }) } as RuntimeSecretOwnershipEvent, { ...scope, operationId: row.pipelineRunId });
    } catch (error) {
      if (error instanceof RuntimeSecretOwnershipPersistenceError) incomplete();
      throw error;
    }
    if (row.metadata?.sha256 !== retained.metadata?.sha256) incomplete();
    const identity = JSON.stringify([row.pipelineRunId, evidence.serviceId, evidence.secretName, evidence.versionToken]);
    if (evidence.phase === "intent") intents.add(identity);
    else {
      owned.add(identity); ownedSecrets.add(String(evidence.secretArn));
      need("aws_secretsmanager_secret", evidence.secretArn);
    }
  }
  if ([...intents].some((intent) => !owned.has(intent)) || [...owned].some((receipt) => !intents.has(receipt))) incomplete();

  const configs = new Map(configurations.map((config) => [config.id, config]));
  if (configs.size !== configurations.length) incomplete();
  for (const config of configurations) {
    if (config.projectId !== scope.projectId || config.environmentName !== scope.environmentName || !operations.has(config.createdByOperationId)
      || !object(config.secretReferences) || !object(config.databaseConfiguration) || typeof config.databaseConfiguration.attached !== "boolean"
      || (config.sealedAt != null && (!(config.sealedAt instanceof Date) || !Number.isFinite(config.sealedAt.getTime())))) incomplete();
    for (const reference of Object.values(config.secretReferences)) {
      if (typeof reference !== "string" || !/^arn:aws:secretsmanager:[a-z0-9-]+:\d{12}:secret:[A-Za-z0-9/_+=.@-]+:[A-Z][A-Z0-9_]{0,127}::[0-9a-f]{64}$/.test(reference)) incomplete();
      const arn = reference.split(":").slice(0, 7).join(":");
      if (!ownedSecrets.has(arn)) incomplete();
      need("aws_secretsmanager_secret", arn);
    }
    // An unsealed failed attempt's intended DB configuration does not prove a
    // database was ever created. Its actual writes still require full journals.
    if (config.databaseConfiguration.attached === true && (config.sealedAt != null || config.databaseConfiguration.runtimeIdentity !== undefined)) {
      const database = config.databaseConfiguration.runtimeIdentity;
      if (!object(database) || database.attached_service_id !== config.serviceId || database.credentials_secret_arn !== config.databaseConfiguration.secretArn) incomplete();
      service(database.ecs_service_arn);
      for (const [type, key] of [
        ["aws_ecs_task_definition", "task_definition_arn"], ["aws_cloudwatch_log_group", "cloudwatch_log_group_name"],
        ["aws_efs_file_system", "efs_file_system_id"], ["aws_efs_access_point", "efs_access_point_id"],
        ["aws_secretsmanager_secret", "credentials_secret_arn"], ["aws_security_group", "security_group_id"],
        ["aws_service_discovery_service", "cloud_map_service_id"], ["aws_service_discovery_private_dns_namespace", "cloud_map_namespace_id"],
      ] as const) need(type, database[key]);
    }
  }
  for (const generation of generations) {
    if (!scope.generationIds.includes(generation.id) || !generation.createdByOperationId || !operations.has(generation.createdByOperationId)
      || !revisions.some((revision) => revision.generationId === generation.id)) incomplete();
  }
  const seen = new Set<string>();
  for (const revision of revisions) {
    const config = configs.get(revision.runtimeConfigRevisionId);
    const identity = JSON.stringify([revision.generationId, revision.serviceId]);
    if (seen.has(identity) || revision.projectId !== scope.projectId || !scope.generationIds.includes(revision.generationId)
      || !config || config.serviceId !== revision.serviceId || !(config.sealedAt instanceof Date) || !Number.isFinite(config.sealedAt.getTime())
      || !object(revision.runtimeIdentity)) incomplete();
    seen.add(identity);
    const imagePrefix = `${scope.accountId}.dkr.ecr.${scope.region}.amazonaws.com/`;
    if (typeof revision.imageUri !== "string" || !revision.imageUri.startsWith(imagePrefix)
      || !/^[a-z0-9][a-z0-9._/-]*$/.test(revision.imageUri.slice(imagePrefix.length))) incomplete();
    need("aws_ecr_repository", revision.imageUri.slice(imagePrefix.length));
    const runtime = revision.runtimeIdentity;
    service(runtime.ecsServiceArn, runtime.ecsClusterArn);
    for (const [type, key] of [["aws_ecs_task_definition", "taskDefinitionArn"], ["aws_lb", "albArn"],
      ["aws_lb_target_group", "targetGroupArn"], ["aws_cloudwatch_log_group", "cloudWatchLogGroupName"]] as const) need(type, runtime[key]);
  }
}
