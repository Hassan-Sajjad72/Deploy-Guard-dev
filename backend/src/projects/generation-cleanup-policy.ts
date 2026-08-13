export const GENERATION_RESOURCE_FIELDS = [
  "ecsServiceArn",
  "taskDefinitionArn",
  "targetGroupArn",
  "candidateListenerRuleArn",
  "logGroupNames",
  "securityGroupIds",
  "autoscalingResourceIds",
] as const;

export const NON_GENERATION_RESOURCE_FIELDS = [
  "vpcId",
  "subnetIds",
  "ecsClusterArn",
  "albArn",
  "listenerArn",
  "stableListenerRuleArn",
  "ecrRepositoryName",
  "runtimeSecretName",
  "efsFileSystemId",
  "efsAccessPointId",
  "databaseServiceArn",
  "projectTerraformStateKey",
] as const;

export type GenerationCleanupTarget = {
  projectId: string;
  environmentName: string;
  generationId: string;
  terraformStateKey: string;
  resources: Record<string, unknown>;
  ownership: {
    ManagedBy: "DeployGuard";
    DeployGuardProjectId: string;
    Environment: string;
    DeployGuardGenerationId: string;
  };
};

export function generationCleanupTarget(input: {
  projectId: string;
  environmentName: string;
  generationId: string;
  terraformStateKey: string;
  resourceManifest: Record<string, unknown>;
}): GenerationCleanupTarget {
  const expectedKey = `projects/${input.projectId}/${input.environmentName}/${input.generationId}/terraform.tfstate`;
  if (input.terraformStateKey !== expectedKey) throw new Error("Generation cleanup state identity mismatch.");
  for (const field of NON_GENERATION_RESOURCE_FIELDS) {
    if (input.resourceManifest[field] !== undefined && input.resourceManifest[field] !== null) {
      throw new Error(`Generation cleanup manifest contains forbidden ${field}.`);
    }
  }
  return {
    projectId: input.projectId,
    environmentName: input.environmentName,
    generationId: input.generationId,
    terraformStateKey: expectedKey,
    resources: Object.fromEntries(GENERATION_RESOURCE_FIELDS
      .filter((field) => input.resourceManifest[field] !== undefined)
      .map((field) => [field, input.resourceManifest[field]])),
    ownership: {
      ManagedBy: "DeployGuard",
      DeployGuardProjectId: input.projectId,
      Environment: input.environmentName,
      DeployGuardGenerationId: input.generationId,
    },
  };
}
