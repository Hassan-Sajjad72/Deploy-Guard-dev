export type RepositoryAnalysisIdentity = {
  repositoryFullName: string | null;
  targetBranch: string;
  commitSha: string | null;
};

export type StoredContractIdentity = {
  repositoryFullName: string | null;
  branch: string;
  commitSha: string | null;
  detectionSourceCommit: string | null;
  buildPlan?: { repositoryFullName?: string; branch?: string; commitSha?: string } | null;
};

export function deploymentContractMatchesIdentity(contract: StoredContractIdentity, identity: RepositoryAnalysisIdentity) {
  const repository = String(identity.repositoryFullName || "").toLowerCase();
  const plan = contract.buildPlan;
  return Boolean(
    repository && identity.commitSha
    && String(contract.repositoryFullName || "").toLowerCase() === repository
    && contract.branch === identity.targetBranch
    && contract.commitSha === identity.commitSha
    && contract.detectionSourceCommit === identity.commitSha
    && String(plan?.repositoryFullName || "").toLowerCase() === repository
    && plan?.branch === identity.targetBranch
    && plan?.commitSha === identity.commitSha
  );
}
