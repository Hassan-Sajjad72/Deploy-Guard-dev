export type GithubActionsDestroyEvidence = {
  contractVersion: "deployguard.destroy-result/v2";
  deploymentOperationId: string;
  projectId: string;
  environmentName: string;
  generationIds: string[];
  status: "project_delete_ready";
  generationResourcesRemoved: true;
  projectResourcesRemoved: true;
  terraformStateArtifactsRemoved: true;
  sharedPlatformUntouched: true;
  verifiedAt: string;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Accept only the exact-scope deletion result emitted after every immutable
 * generation state and the separate project-persistence state have converged.
 * Shared platform absence is intentionally neither requested nor accepted.
 */
export function extractGithubActionsDestroyEvidence(log: string): GithubActionsDestroyEvidence | null {
  const lines = log.split(/\r?\n/).filter((line) => line.includes("DEPLOYGUARD_DESTROY_RESULT="));
  for (const line of lines.reverse()) {
    const marker = line.indexOf("DEPLOYGUARD_DESTROY_RESULT=");
    try {
      const value = JSON.parse(line.slice(marker + "DEPLOYGUARD_DESTROY_RESULT=".length).trim()) as Record<string, unknown>;
      const generationIds = Array.isArray(value.generationIds)
        ? value.generationIds.filter((id): id is string => typeof id === "string")
        : [];
      if (
        value.contractVersion !== "deployguard.destroy-result/v2"
        || typeof value.deploymentOperationId !== "string"
        || !UUID.test(value.deploymentOperationId)
        || typeof value.projectId !== "string"
        || !UUID.test(value.projectId)
        || typeof value.environmentName !== "string"
        || !value.environmentName
        || !generationIds.length
        || generationIds.some((id) => !UUID.test(id))
        || new Set(generationIds).size !== generationIds.length
        || value.status !== "project_delete_ready"
        || value.generationResourcesRemoved !== true
        || value.projectResourcesRemoved !== true
        || value.terraformStateArtifactsRemoved !== true
        || value.sharedPlatformUntouched !== true
        || typeof value.verifiedAt !== "string"
        || Number.isNaN(Date.parse(value.verifiedAt))
      ) continue;
      return {
        contractVersion: "deployguard.destroy-result/v2",
        deploymentOperationId: value.deploymentOperationId,
        projectId: value.projectId,
        environmentName: value.environmentName,
        generationIds: [...generationIds].sort(),
        status: "project_delete_ready",
        generationResourcesRemoved: true,
        projectResourcesRemoved: true,
        terraformStateArtifactsRemoved: true,
        sharedPlatformUntouched: true,
        verifiedAt: value.verifiedAt,
      };
    } catch {
      // Malformed and unrelated output cannot advance deletion authority.
    }
  }
  return null;
}
