import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { ProjectStableRelease, StableReleaseStatus } from "../../orchestration/project-stable-release.entity";
import { canonicalEnvironmentName } from "../canonical-environment";
import { DeploymentGenerationStatus, ProjectDeploymentGeneration } from "../project-deployment-generation.entity";
import { ProjectEnvironmentRoute } from "../project-environment-route.entity";
import { Project } from "../project.entity";

@Injectable()
export class LiveRuntimeIdentityRecoveryService {
  constructor(
    @InjectRepository(ProjectDeploymentGeneration) private readonly generations: Repository<ProjectDeploymentGeneration>,
    @InjectRepository(ProjectStableRelease) private readonly releases: Repository<ProjectStableRelease>,
    @InjectRepository(ProjectEnvironmentRoute) private readonly routes: Repository<ProjectEnvironmentRoute>,
  ) {}

  async recover(project: Project): Promise<Record<string, unknown> | null> {
    const environmentName = canonicalEnvironmentName(project);
    const route = await this.routes.findOne({ where: { projectId: project.id, environmentName } });
    if (!route?.liveGenerationId) return null;
    const [generation, release] = await Promise.all([
      this.generations.findOne({ where: { id: route.liveGenerationId, projectId: project.id, environmentName, status: DeploymentGenerationStatus.LIVE } }),
      this.releases.findOne({ where: { projectId: project.id, environmentName, generationId: route.liveGenerationId, status: StableReleaseStatus.STABLE } }),
    ]);
    if (!generation || !release?.deployedByPipelineRunId || release.metadata?.releaseEvidenceVerified !== true) return generation?.resourceManifest || null;
    const manifest = this.mergeKnown(generation.resourceManifest || {}, this.runtimeMetadata(release));
    // Recovery never reconstructs a generation from deprecated scalar release
    // columns. The complete persisted service set is the only authority.
    return manifest;
  }

  private runtimeMetadata(release: ProjectStableRelease) {
    const value = release.metadata?.runtimeIdentity;
    return value && typeof value === "object" ? value as Record<string, unknown> : {};
  }
  private mergeKnown(...sources: Array<Record<string, unknown>>) {
    const merged: Record<string, unknown> = {};
    for (const source of sources) for (const [key, value] of Object.entries(source)) {
      if (value !== null && value !== undefined && value !== "") merged[key] = value;
    }
    return merged;
  }
}
