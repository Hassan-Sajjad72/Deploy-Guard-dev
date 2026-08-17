import { BadRequestException, ConflictException } from "@nestjs/common";
import { DetectionStatus } from "./project-detection-profile.entity";

type ProjectIdentity = { id: string; repositoryUrl: string; repositoryFullName: string; targetBranch: string };
type ProfileIdentity = { repositoryFullName: string; targetBranch: string; commitSha: string; detectionStatus: string };
type ContractIdentity = { commitSha: string | null; detectionSourceCommit: string | null };

export async function refreshDeploymentAnalysisIfStale<TProject extends ProjectIdentity, TProfile extends ProfileIdentity, TContract extends ContractIdentity>(input: {
  project: TProject;
  profile: TProfile;
  contract: TContract;
  remoteCommit: string;
  runAuthoritativeDetection: () => Promise<{ detectionStatus: string }>;
  reload: () => Promise<{ project: TProject; profile: TProfile | null; contract: TContract }>;
  resolveRemoteCommit: (project: TProject) => Promise<string>;
}) {
  const sameRepositoryAndBranch = input.profile.repositoryFullName === input.project.repositoryFullName
    && input.profile.targetBranch === input.project.targetBranch;
  const staleCommit = sameRepositoryAndBranch && (
    input.profile.commitSha !== input.remoteCommit
    || input.contract.commitSha !== input.remoteCommit
    || input.contract.detectionSourceCommit !== input.remoteCommit
  );
  if (!staleCommit) return { project: input.project, profile: input.profile, contract: input.contract, remoteCommit: input.remoteCommit, refreshed: false };

  const originalIdentity = `${input.project.repositoryFullName}#${input.project.targetBranch}`;
  const refreshed = await input.runAuthoritativeDetection();
  if (refreshed.detectionStatus !== DetectionStatus.SUCCESS) {
    throw new BadRequestException({ code: "redeploy_detection_failed", message: "Fresh repository analysis did not produce a deployable profile." });
  }
  const current = await input.reload();
  if (`${current.project.repositoryFullName}#${current.project.targetBranch}` !== originalIdentity) {
    throw new ConflictException({ code: "deployment_identity_changed", message: "Repository or branch changed during deployment analysis. Review readiness again." });
  }
  const remoteCommit = await input.resolveRemoteCommit(current.project);
  if (!current.profile
    || current.profile.commitSha !== remoteCommit
    || current.contract.commitSha !== remoteCommit
    || current.contract.detectionSourceCommit !== remoteCommit) {
    throw new ConflictException({ code: "repository_advanced_during_analysis", message: "The selected branch advanced during deployment analysis. Review readiness again." });
  }
  return { ...current, remoteCommit, refreshed: true };
}
