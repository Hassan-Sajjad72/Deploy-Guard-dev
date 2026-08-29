import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { DescribeServicesCommand, DescribeTaskDefinitionCommand, ECSClient } from "@aws-sdk/client-ecs";
import { DescribeLoadBalancersCommand, DescribeTagsCommand, DescribeTargetGroupsCommand, ElasticLoadBalancingV2Client } from "@aws-sdk/client-elastic-load-balancing-v2";
import { DataSource, Repository } from "typeorm";
import { ProjectStableRelease, StableReleaseStatus } from "../../orchestration/project-stable-release.entity";
import { canonicalEnvironmentName } from "../canonical-environment";
import { DeploymentGenerationStatus, ProjectDeploymentGeneration } from "../project-deployment-generation.entity";
import { ProjectEnvironmentRoute } from "../project-environment-route.entity";
import { Project } from "../project.entity";

const ECS_SERVICE_ARN = /^arn:(aws|aws-us-gov|aws-cn):ecs:([a-z0-9-]+):(\d{12}):service\/([^/]+)\/([^/]+)$/;
const TASK_DEFINITION_ARN = /^arn:(aws|aws-us-gov|aws-cn):ecs:([a-z0-9-]+):(\d{12}):task-definition\/[^/:]+:\d+$/;
const ECR_REPOSITORY = /^(\d{12})\.dkr\.ecr\.([a-z0-9-]+)\.amazonaws\.com\/[a-z0-9][a-z0-9._\/-]*$/i;

@Injectable()
export class LiveRuntimeIdentityRecoveryService {
  constructor(
    @InjectRepository(ProjectDeploymentGeneration) private readonly generations: Repository<ProjectDeploymentGeneration>,
    @InjectRepository(ProjectStableRelease) private readonly releases: Repository<ProjectStableRelease>,
    @InjectRepository(ProjectEnvironmentRoute) private readonly routes: Repository<ProjectEnvironmentRoute>,
    private readonly dataSource: DataSource,
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
    if (this.complete(manifest)) return manifest;
    const recovered = await this.readVerifiedIdentity(project, release, manifest).catch(() => null);
    if (!recovered) return manifest;
    const identity = { ...manifest, ...recovered };
    await this.persist(project.id, environmentName, generation.id, release.id, route.id, identity);
    return identity;
  }

  private async readVerifiedIdentity(project: Project, release: ProjectStableRelease, manifest: Record<string, unknown>) {
    const serviceMatch = release.ecsServiceArn?.match(ECS_SERVICE_ARN);
    const taskMatch = release.taskDefinitionArn?.match(TASK_DEFINITION_ARN);
    const repositoryMatch = release.imageUri?.match(ECR_REPOSITORY);
    const digest = typeof release.metadata?.imageDigest === "string" ? release.metadata.imageDigest : "";
    if (!serviceMatch || !taskMatch || !repositoryMatch || !/^sha256:[0-9a-f]{64}$/.test(digest)) return null;
    const [, partition, region, accountId, clusterName, serviceName] = serviceMatch;
    if (taskMatch[1] !== partition || taskMatch[2] !== region || taskMatch[3] !== accountId || repositoryMatch[1] !== accountId || repositoryMatch[2] !== region) return null;
    const ecs = this.ecs(region);
    const elb = this.elb(region);
    const [serviceResult, taskResult] = await Promise.all([
      ecs.send(new DescribeServicesCommand({ cluster: clusterName, services: [release.ecsServiceArn], include: ["TAGS"] })),
      ecs.send(new DescribeTaskDefinitionCommand({ taskDefinition: release.taskDefinitionArn, include: ["TAGS"] })),
    ]);
    const service = serviceResult.services?.[0];
    const taskDefinition = taskResult.taskDefinition;
    const ownsRelease = (tags: Array<{ key?: string; value?: string }> | undefined) => {
      const values = Object.fromEntries((tags || []).map((tag) => [tag.key || "", tag.value || ""]));
      return values.ManagedBy === "DeployGuard" && values.DeployGuardProjectId === project.id && values.DeployGuardOperationId === release.deployedByPipelineRunId;
    };
    if (!service?.serviceArn || service.serviceArn !== release.ecsServiceArn || service.status !== "ACTIVE" || service.taskDefinition !== release.taskDefinitionArn || !ownsRelease(service.tags) || !ownsRelease(taskResult.tags)) return null;
    const targetGroupArn = service.loadBalancers?.find((item) => item.containerName === "application")?.targetGroupArn;
    const immutableImage = `${release.imageUri}@${digest}`;
    const application = taskDefinition?.containerDefinitions?.find((container) => container.name === "application" && container.image === immutableImage);
    const logOptions = application?.logConfiguration?.options || {};
    if (!targetGroupArn || !application || logOptions["awslogs-group"] !== `/deployguard/${project.id}/application`) return null;
    const [targetGroups, targetTags] = await Promise.all([
      elb.send(new DescribeTargetGroupsCommand({ TargetGroupArns: [targetGroupArn] })),
      elb.send(new DescribeTagsCommand({ ResourceArns: [targetGroupArn] })),
    ]);
    const targetGroup = targetGroups.TargetGroups?.[0];
    const tagValues = Object.fromEntries((targetTags.TagDescriptions?.[0]?.Tags || []).map((tag) => [tag.Key || "", tag.Value || ""]));
    if (targetGroup?.TargetGroupArn !== targetGroupArn || !targetGroup.LoadBalancerArns?.[0] || tagValues.ManagedBy !== "DeployGuard" || tagValues.DeployGuardProjectId !== project.id || tagValues.DeployGuardOperationId !== release.deployedByPipelineRunId) return null;
    const loadBalancerArn = targetGroup.LoadBalancerArns[0];
    const loadBalancers = await elb.send(new DescribeLoadBalancersCommand({ LoadBalancerArns: [loadBalancerArn] }));
    const loadBalancer = loadBalancers.LoadBalancers?.[0];
    const publicHost = this.publicHost(release.metadata?.deployedUrl);
    if (loadBalancer?.LoadBalancerArn !== loadBalancerArn || !loadBalancer.DNSName || publicHost !== loadBalancer.DNSName) return null;
    return {
      ...manifest,
      region,
      ecsClusterArn: service.clusterArn || null,
      ecsClusterName: clusterName,
      ecsServiceArn: release.ecsServiceArn,
      ecsServiceName: service.serviceName || serviceName,
      taskDefinitionArn: release.taskDefinitionArn,
      targetGroupArn,
      targetGroupName: targetGroup.TargetGroupName || null,
      albArn: loadBalancerArn,
      albName: loadBalancer.LoadBalancerName || null,
      publicUrl: release.metadata?.deployedUrl,
      cloudWatchLogGroupName: logOptions["awslogs-group"],
      applicationContainerName: application.name,
      imageUri: release.imageUri,
      imageDigest: digest,
      terraformStateKey: `projects/${project.id}/${canonicalEnvironmentName(project)}/runtime/terraform.tfstate`,
    };
  }

  private async persist(projectId: string, environmentName: string, generationId: string, releaseId: string, routeId: string, identity: Record<string, unknown>) {
    await this.dataSource.transaction(async (manager) => {
      await manager.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`live-runtime-identity:${projectId}:${environmentName}`]);
      const generation = await manager.getRepository(ProjectDeploymentGeneration).findOne({ where: { id: generationId, projectId, environmentName, status: DeploymentGenerationStatus.LIVE } });
      const release = await manager.getRepository(ProjectStableRelease).findOne({ where: { id: releaseId, projectId, environmentName, generationId, status: StableReleaseStatus.STABLE } });
      const route = await manager.getRepository(ProjectEnvironmentRoute).findOne({ where: { id: routeId, projectId, environmentName, liveGenerationId: generationId } });
      if (!generation || !release || !route) return;
      generation.resourceManifest = { ...generation.resourceManifest, ...identity };
      release.metadata = { ...(release.metadata || {}), runtimeIdentity: identity };
      route.metadata = { ...route.metadata, runtimeIdentity: identity };
      await manager.getRepository(ProjectDeploymentGeneration).save(generation);
      await manager.getRepository(ProjectStableRelease).save(release);
      await manager.getRepository(ProjectEnvironmentRoute).save(route);
    });
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
  private complete(identity: Record<string, unknown>) {
    return ["region", "ecsClusterArn", "ecsServiceArn", "taskDefinitionArn", "targetGroupArn", "albArn", "publicUrl", "cloudWatchLogGroupName", "applicationContainerName", "imageUri", "imageDigest", "terraformStateKey"]
      .every((key) => typeof identity[key] === "string" && Boolean(identity[key]));
  }
  private publicHost(value: unknown) {
    try { return typeof value === "string" ? new URL(value).hostname : ""; } catch { return ""; }
  }
  protected ecs(region: string) { return new ECSClient({ region }); }
  protected elb(region: string) { return new ElasticLoadBalancingV2Client({ region }); }
}
