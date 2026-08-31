import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { ProjectStableRelease, StableReleaseStatus } from "../../orchestration/project-stable-release.entity";
import { canonicalEnvironmentName } from "../canonical-environment";
import { DeploymentGenerationStatus, ProjectDeploymentGeneration } from "../project-deployment-generation.entity";
import { ProjectEnvironmentRoute } from "../project-environment-route.entity";
import { ProjectGenerationServiceRevision } from "../project-generation-service-revision.entity";
import { Project } from "../project.entity";

@Injectable()
export class LiveRuntimeIdentityRecoveryService {
  constructor(
    @InjectRepository(ProjectDeploymentGeneration) private readonly generations: Repository<ProjectDeploymentGeneration>,
    @InjectRepository(ProjectStableRelease) private readonly releases: Repository<ProjectStableRelease>,
    @InjectRepository(ProjectEnvironmentRoute) private readonly routes: Repository<ProjectEnvironmentRoute>,
    @InjectRepository(ProjectGenerationServiceRevision) private readonly serviceRevisions: Repository<ProjectGenerationServiceRevision>,
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
    const revisions = await this.serviceRevisions.find({ where: { generationId: generation.id, projectId: project.id } });
    if (!revisions.length) return this.mergeKnown(generation.resourceManifest || {}, this.runtimeMetadata(release));

    // A revision is the immutable runtime authority. resource_manifest and
    // release metadata may still cache a projection, but neither is consulted
    // when canonical service revisions exist.
    const services = revisions.slice().sort((left, right) => left.serviceId.localeCompare(right.serviceId)).map((revision) => {
      const identity = revision.runtimeIdentity || {};
      const text = (key: string) => typeof identity[key] === "string" ? identity[key] : undefined;
      return {
        serviceId: revision.serviceId,
        serviceName: revision.serviceName,
        serviceDirectory: revision.serviceDirectory,
        sourceSha: revision.sourceSha,
        imageUri: revision.imageUri,
        imageDigest: revision.imageDigest,
        runtimeConfigRevisionId: revision.runtimeConfigRevisionId,
        publicUrl: text("publicUrl"),
        region: text("region"),
        ecsClusterArn: text("ecsClusterArn"),
        ecsClusterName: text("ecsClusterName"),
        ecsServiceArn: text("ecsServiceArn"),
        ecsServiceName: text("ecsServiceName"),
        taskDefinitionArn: text("taskDefinitionArn"),
        albArn: text("albArn"),
        albName: text("albName"),
        targetGroupArn: text("targetGroupArn"),
        targetGroupName: text("targetGroupName"),
        cloudWatchLogGroupName: text("cloudWatchLogGroupName"),
        applicationContainerName: text("applicationContainerName"),
      };
    });
    // Region and ECS cluster are project-generation facts emitted by the
    // Terraform module, not properties selected from an arbitrary service.
    // Only these explicit generation-level fields are read from the manifest;
    // service identity always remains the immutable revision set above.
    const shared = this.generationSharedRuntimeIdentity(generation);
    return this.mergeKnown({
      ...shared,
      terraformStateKey: generation.terraformStateKey,
      services,
    });
  }

  private generationSharedRuntimeIdentity(generation: ProjectDeploymentGeneration) {
    const manifest = generation.resourceManifest || {};
    const text = (key: "region" | "ecsClusterArn" | "ecsClusterName") =>
      typeof manifest[key] === "string" ? manifest[key] : undefined;
    return {
      region: text("region"),
      ecsClusterArn: text("ecsClusterArn"),
      ecsClusterName: text("ecsClusterName"),
    };
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
