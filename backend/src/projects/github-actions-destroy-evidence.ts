import { isCanonicalEnvironmentName } from "./canonical-environment";
import type { ProjectPipelineRun } from "./project-pipeline-run.entity";
import { assertRailpackRuntimeConfiguration, RailpackRuntimeConfiguration } from "./railpack-workflow-contract";

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
 * Parse the versioned deletion claim. Structural validity and exact identity
 * are not independent AWS absence proof. Shared resources are not selected.
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
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  const generationIds = Array.isArray(candidate.generationIds)
    ? candidate.generationIds
    : [];
  if (
    candidate.contractVersion !== "deployguard.destroy-result/v2"
    || typeof candidate.deploymentOperationId !== "string"
    || !UUID.test(candidate.deploymentOperationId)
    || typeof candidate.projectId !== "string"
    || !UUID.test(candidate.projectId)
    || typeof candidate.environmentName !== "string"
    || !isCanonicalEnvironmentName(candidate.environmentName)
    || !generationIds.length
    || generationIds.some((id) => typeof id !== "string" || !UUID.test(id))
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

/** Exact frozen scope is necessary, but does not itself prove AWS absence. */
export function githubActionsDestroyEvidenceMatchesOperation(
  evidence: GithubActionsDestroyEvidence,
  operation: Pick<ProjectPipelineRun, "id" | "projectId" | "generationId" | "commitSha" | "metadata">,
  environmentName: string,
): boolean {
  if (evidence.deploymentOperationId !== operation.id || evidence.projectId !== operation.projectId
    || evidence.environmentName !== environmentName || !operation.generationId) return false;
  const encoded = (operation.metadata?.immutableDispatchInputs as Record<string, unknown> | undefined)?.services_base64;
  if (typeof encoded !== "string") return false;
  try {
    const runtime = JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as RailpackRuntimeConfiguration;
    assertRailpackRuntimeConfiguration(runtime);
    if (runtime.projectId !== operation.projectId || runtime.operationId !== operation.id
      || runtime.sourceSha !== operation.commitSha || runtime.environmentName !== environmentName) return false;
    const expected = runtime.projectDeletion?.generationIds;
    return Array.isArray(expected) && expected.includes(operation.generationId)
      && expected.length === evidence.generationIds.length
      && [...expected].sort().every((id, index) => id === evidence.generationIds[index]);
  } catch { return false; }
}
