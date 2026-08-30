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
      const evidence = githubActionsDestroyEvidenceFromValue(value);
      if (evidence) return evidence;
    } catch {
      // Malformed and unrelated output cannot advance deletion authority.
    }
  }
  return null;
}

/** Validate an artifact payload before it can erase project runtime authority. */
export function githubActionsDestroyEvidenceFromValue(value: unknown): GithubActionsDestroyEvidence | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  const generationIds = Array.isArray(candidate.generationIds)
    ? candidate.generationIds.filter((id): id is string => typeof id === "string")
    : [];
  if (
    candidate.contractVersion !== "deployguard.destroy-result/v2"
    || typeof candidate.deploymentOperationId !== "string"
    || !UUID.test(candidate.deploymentOperationId)
    || typeof candidate.projectId !== "string"
    || !UUID.test(candidate.projectId)
    || typeof candidate.environmentName !== "string"
    || !candidate.environmentName
    || !generationIds.length
    || generationIds.some((id) => !UUID.test(id))
    || new Set(generationIds).size !== generationIds.length
    || candidate.status !== "project_delete_ready"
    || candidate.generationResourcesRemoved !== true
    || candidate.projectResourcesRemoved !== true
    || candidate.terraformStateArtifactsRemoved !== true
    || candidate.sharedPlatformUntouched !== true
    || typeof candidate.verifiedAt !== "string"
    || Number.isNaN(Date.parse(candidate.verifiedAt))
  ) return null;
  return {
    contractVersion: "deployguard.destroy-result/v2",
    deploymentOperationId: candidate.deploymentOperationId,
    projectId: candidate.projectId,
    environmentName: candidate.environmentName,
    generationIds: [...generationIds].sort(),
    status: "project_delete_ready",
    generationResourcesRemoved: true,
    projectResourcesRemoved: true,
    terraformStateArtifactsRemoved: true,
    sharedPlatformUntouched: true,
    verifiedAt: candidate.verifiedAt,
  };
}
