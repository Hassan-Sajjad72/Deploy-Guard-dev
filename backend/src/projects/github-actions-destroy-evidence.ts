export type GithubActionsDestroyEvidence = {
  deploymentOperationId: string;
  status: "verified_destroyed";
  ecsServicesAbsent: true;
  runningTasksZero: true;
  loadBalancersAbsent: true;
  listenersAbsent: true;
  targetGroupsAbsent: true;
  endpointUnavailable: true;
  imageRepositoryAbsent: true;
  runtimeSecretAbsent: true;
  activeGenerationTaskDefinitionsAbsent: true;
  normalResourcesAbsent: true;
  projectOwnedAwsResourcesAbsent: true;
  allProjectTerraformArtifactsAbsent: true;
  /** Required for current workflow evidence; absent only on reconciled legacy results. */
  terraformStateVersionsAbsent?: true;
  retainedResourcesVerified: true;
  retainedTerraformAddresses: string[];
  verifiedAt: string;
};

export type GithubActionsDestroyProgress = {
  deploymentOperationId: string;
  status: "DESTROY_INCOMPLETE";
  phase: "AWS_CLEANUP" | "DESTROY_VERIFYING";
  remaining: Array<{
    resourceType: string;
    resourceId: string;
    ownershipScope: "generation" | "project" | "platform_shared";
    reason: string;
    errorCode?: string;
    errorMessage?: string;
    retryable: boolean;
    attemptCount: number;
    firstSeenAt: string;
    lastSeenAt: string;
    nextRetryAt?: string;
  }>;
  terraform: Record<string, unknown>;
  verifiedAt: string;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/**
 * Accept only the bounded, non-sensitive absence attestation emitted after a
 * destroy workflow verifies the exact resources captured from Terraform state.
 */
export function extractGithubActionsDestroyEvidence(log: string): GithubActionsDestroyEvidence | null {
  const lines = log.split(/\r?\n/).filter((line) => line.includes("DEPLOYGUARD_DESTROY_RESULT="));
  for (const line of lines.reverse()) {
    const marker = line.indexOf("DEPLOYGUARD_DESTROY_RESULT=");
    const serialized = line.slice(marker + "DEPLOYGUARD_DESTROY_RESULT=".length).trim();
    try {
      const value = JSON.parse(serialized) as Record<string, unknown>;
      const verifiedAt = typeof value.verifiedAt === "string" ? value.verifiedAt : "";
      const retainedTerraformAddresses = Array.isArray(value.retainedTerraformAddresses)
        ? value.retainedTerraformAddresses.filter(
            (address): address is string => typeof address === "string",
          )
        : [];
      if (
        typeof value.deploymentOperationId !== "string"
        || !UUID.test(value.deploymentOperationId)
        || value.status !== "verified_destroyed"
        || value.ecsServicesAbsent !== true
        || value.runningTasksZero !== true
        || value.loadBalancersAbsent !== true
        || value.listenersAbsent !== true
        || value.targetGroupsAbsent !== true
        || value.endpointUnavailable !== true
        || value.imageRepositoryAbsent !== true
        || value.runtimeSecretAbsent !== true
        || value.activeGenerationTaskDefinitionsAbsent !== true
        || value.normalResourcesAbsent !== true
        || value.projectOwnedAwsResourcesAbsent !== true
        || value.allProjectTerraformArtifactsAbsent !== true
        || value.terraformStateVersionsAbsent !== true
        || value.retainedResourcesVerified !== true
        || !Array.isArray(value.retainedTerraformAddresses)
        || retainedTerraformAddresses.length !== 0
        || !verifiedAt
        || Number.isNaN(Date.parse(verifiedAt))
      ) continue;
      return {
        deploymentOperationId: value.deploymentOperationId,
        status: "verified_destroyed",
        ecsServicesAbsent: true,
        runningTasksZero: true,
        loadBalancersAbsent: true,
        listenersAbsent: true,
        targetGroupsAbsent: true,
        endpointUnavailable: true,
        imageRepositoryAbsent: true,
        runtimeSecretAbsent: true,
        activeGenerationTaskDefinitionsAbsent: true,
        normalResourcesAbsent: true,
        projectOwnedAwsResourcesAbsent: true,
        allProjectTerraformArtifactsAbsent: true,
        terraformStateVersionsAbsent: true,
        retainedResourcesVerified: true,
        retainedTerraformAddresses: [...retainedTerraformAddresses].sort(),
        verifiedAt,
      };
    } catch {
      // Malformed and unrelated output is ignored; reconciliation fails closed.
    }
  }
  return null;
}

/** Persistable progress is accepted only from the bounded Destroy marker. */
export function extractGithubActionsDestroyProgress(log: string): GithubActionsDestroyProgress | null {
  const lines = log.split(/\r?\n/).filter((line) => line.includes("DEPLOYGUARD_DESTROY_PROGRESS="));
  for (const line of lines.reverse()) {
    const marker = line.indexOf("DEPLOYGUARD_DESTROY_PROGRESS=");
    const serialized = line.slice(marker + "DEPLOYGUARD_DESTROY_PROGRESS=".length).trim();
    try {
      const value = JSON.parse(serialized) as Record<string, unknown>;
      if (typeof value.deploymentOperationId !== "string" || !UUID.test(value.deploymentOperationId)
        || value.status !== "DESTROY_INCOMPLETE"
        || !["AWS_CLEANUP", "DESTROY_VERIFYING"].includes(String(value.phase || ""))
        || !Array.isArray(value.remaining)
        || value.remaining.length === 0
        || value.remaining.length > 2_000
        || typeof value.verifiedAt !== "string"
        || Number.isNaN(Date.parse(value.verifiedAt))) continue;
      const remaining = value.remaining.map((raw) => {
        const item = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
        if (typeof item.resourceType !== "string" || !item.resourceType
          || typeof item.resourceId !== "string" || !item.resourceId
          || !["generation", "project", "platform_shared"].includes(String(item.ownershipScope || ""))
          || typeof item.reason !== "string" || !item.reason
          || typeof item.retryable !== "boolean"
          || !Number.isInteger(Number(item.attemptCount)) || Number(item.attemptCount) < 1
          || typeof item.firstSeenAt !== "string" || Number.isNaN(Date.parse(item.firstSeenAt))
          || typeof item.lastSeenAt !== "string" || Number.isNaN(Date.parse(item.lastSeenAt))) throw new Error("invalid remaining resource");
        return {
          resourceType: item.resourceType.slice(0, 128),
          resourceId: item.resourceId.slice(0, 2_048),
          ownershipScope: item.ownershipScope as "generation" | "project" | "platform_shared",
          reason: item.reason.slice(0, 512),
          ...(typeof item.errorCode === "string" ? { errorCode: item.errorCode.slice(0, 128) } : {}),
          ...(typeof item.errorMessage === "string" ? { errorMessage: item.errorMessage.slice(0, 1_000) } : {}),
          retryable: item.retryable,
          attemptCount: Number(item.attemptCount),
          firstSeenAt: item.firstSeenAt,
          lastSeenAt: item.lastSeenAt,
          ...(typeof item.nextRetryAt === "string" && !Number.isNaN(Date.parse(item.nextRetryAt)) ? { nextRetryAt: item.nextRetryAt } : {}),
        };
      });
      return {
        deploymentOperationId: value.deploymentOperationId,
        status: "DESTROY_INCOMPLETE",
        phase: value.phase as "AWS_CLEANUP" | "DESTROY_VERIFYING",
        remaining,
        terraform: value.terraform && typeof value.terraform === "object" && !Array.isArray(value.terraform)
          ? value.terraform as Record<string, unknown>
          : {},
        verifiedAt: value.verifiedAt,
      };
    } catch {
      // Malformed progress is ignored and cannot advance lifecycle authority.
    }
  }
  return null;
}
