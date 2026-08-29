import { EntityManager } from "typeorm";
import { ProjectStableRelease, StableReleaseStatus } from "../orchestration/project-stable-release.entity";

export type StableReleaseProjectionInput = {
  projectId: string;
  generationId: string;
  environmentName: string;
  operationId: string;
  commitSha: string;
  imageUri: string;
  taskDefinitionArn: string;
  ecsServiceArn: string;
  healthCheckPath: string;
  appPort: number;
  metadata: Record<string, unknown>;
};

export async function materializeStableRelease(
  manager: EntityManager,
  input: StableReleaseProjectionInput,
) {
  await manager.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
    `stable-release:${input.projectId}:${input.environmentName}`,
  ]);
  const releases = manager.getRepository(ProjectStableRelease);
  const existing = await releases.findOne({ where: { deployedByPipelineRunId: input.operationId } });
  if (existing) {
    if (
      existing.projectId !== input.projectId
      || existing.environmentName !== input.environmentName
      || existing.generationId !== input.generationId
      || existing.commitSha !== input.commitSha
    ) {
      throw new Error("Stable release operation identity is inconsistent with immutable deployment facts.");
    }
    return existing;
  }

  const current = await releases.findOne({
    where: {
      projectId: input.projectId,
      environmentName: input.environmentName,
      status: StableReleaseStatus.STABLE,
    },
  });
  const olderTargets = await releases.find({
    where: {
      projectId: input.projectId,
      environmentName: input.environmentName,
      status: StableReleaseStatus.ROLLBACK_TARGET,
    },
  });
  for (const target of olderTargets) {
    target.status = StableReleaseStatus.SUPERSEDED;
    await releases.save(target);
  }
  if (current) {
    current.status = StableReleaseStatus.ROLLBACK_TARGET;
    await releases.save(current);
  }
  return releases.save(releases.create({
    projectId: input.projectId,
    generationId: input.generationId,
    releaseManifestId: null,
    environmentName: input.environmentName,
    commitSha: input.commitSha,
    shortCommitSha: input.commitSha.slice(0, 12),
    imageUri: input.imageUri,
    taskDefinitionArn: input.taskDefinitionArn,
    ecsServiceArn: input.ecsServiceArn,
    healthCheckPath: input.healthCheckPath,
    appPort: input.appPort,
    deployedByPipelineRunId: input.operationId,
    deployedAt: new Date(),
    status: StableReleaseStatus.STABLE,
    metadata: input.metadata,
  }));
}
