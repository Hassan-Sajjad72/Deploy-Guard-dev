import { BadRequestException, Injectable, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectRepository } from "@nestjs/typeorm";
import {
  DescribeServicesCommand,
  DescribeTaskDefinitionCommand,
  ECSClient,
  ListTasksCommand,
} from "@aws-sdk/client-ecs";
import {
  DescribeTargetGroupsCommand,
  DescribeTargetHealthCommand,
  ElasticLoadBalancingV2Client,
} from "@aws-sdk/client-elastic-load-balancing-v2";
import { Repository } from "typeorm";
import { ProjectStableRelease, StableReleaseStatus } from "../orchestration/project-stable-release.entity";
import { canonicalEnvironmentName } from "../projects/canonical-environment";
import { DeploymentGenerationStatus, ProjectDeploymentGeneration } from "../projects/project-deployment-generation.entity";
import { Project, ProjectStatus } from "../projects/project.entity";
import { User, UserRole } from "../users/user.entity";
import { LiveRuntimeIdentityRecoveryService } from "../projects/current-state/live-runtime-identity-recovery.service";

export type LiveRuntimeIdentity = {
  projectId: string;
  environmentName: string;
  generationId: string;
  releaseId: string;
  operationId: string | null;
  serviceId: string;
  serviceDisplayName: string;
  publicUrl: string | null;
  region: string;
  cluster: string;
  clusterName: string;
  serviceArn: string;
  serviceName: string;
  taskDefinitionArn: string;
  taskArns: string[];
  targetGroupArn: string;
  loadBalancerArn: string;
  logGroupName: string;
  logStreamPrefix: string;
  containerName: string;
  resolvedAt: string;
  targetHealth: string[];
};

/** The persisted LIVE release is valid, but lacks immutable runtime identity. */
export class RuntimeIdentityUnavailableException extends ServiceUnavailableException {}
/** The immutable identity exists, but ECS/ALB cannot currently verify it. */
export class AwsRuntimeUnavailableException extends ServiceUnavailableException {}

@Injectable()
export class LiveRuntimeResolverService {
  private readonly cache = new Map<string, { expiresAt: number; value: LiveRuntimeIdentity }>();

  constructor(
    @InjectRepository(Project) private readonly projects: Repository<Project>,
    @InjectRepository(ProjectDeploymentGeneration) private readonly generations: Repository<ProjectDeploymentGeneration>,
    @InjectRepository(ProjectStableRelease) private readonly releases: Repository<ProjectStableRelease>,
    private readonly config: ConfigService,
    private readonly runtimeIdentityRecovery: LiveRuntimeIdentityRecoveryService,
  ) {}

  async resolveForUser(user: User, projectId: string, serviceId?: string) {
    const project = await this.projects.findOne({ where: { id: projectId } });
    if (!project || project.status === ProjectStatus.ARCHIVED) throw new NotFoundException("Project not found");
    const canView = user.role === UserRole.ADMIN
      || project.ownerUserId === user.id
      || (user.role === UserRole.READONLY && project.visibility === "workspace");
    if (!canView) throw new NotFoundException("Project not found");
    return this.resolveProject(project, serviceId);
  }

  async resolveProjectId(projectId: string, serviceId?: string) {
    const project = await this.projects.findOne({ where: { id: projectId } });
    if (!project || project.status === ProjectStatus.ARCHIVED) throw new NotFoundException("Project not found");
    return this.resolveProject(project, serviceId);
  }

  async liveProjectIds() {
    const rows = await this.releases.find({
      where: { status: StableReleaseStatus.STABLE },
      select: { projectId: true, generationId: true },
    });
    return [...new Set(rows.filter((row) => row.generationId).map((row) => row.projectId))];
  }

  invalidate(projectId: string) {
    for (const key of this.cache.keys()) if (key === projectId || key.startsWith(`${projectId}:`)) this.cache.delete(key);
  }

  private async resolveProject(project: Project, requestedServiceId?: string): Promise<LiveRuntimeIdentity> {
    const environmentName = canonicalEnvironmentName(project);
    const release = await this.releases.findOne({
      where: { projectId: project.id, environmentName, status: StableReleaseStatus.STABLE },
      order: { deployedAt: "DESC" },
    });
    if (!release?.generationId) {
      throw new RuntimeIdentityUnavailableException("No authoritative LIVE runtime is available for this project.");
    }

    const generation = await this.generations.findOne({
      where: {
        id: release.generationId,
        projectId: project.id,
        environmentName,
        status: DeploymentGenerationStatus.LIVE,
      },
    });
    const manifest = await this.runtimeIdentityRecovery.recover(project) || {};
    const string = (key: string) => typeof manifest[key] === "string" ? manifest[key] : "";
    const persistedServices = Array.isArray(manifest.services)
      ? manifest.services.filter((value): value is Record<string, unknown> => Boolean(value) && typeof value === "object")
      : [];
    const selected = requestedServiceId
      ? persistedServices.find((service) => service.serviceId === requestedServiceId)
      : persistedServices.length ? persistedServices.reduce((chosen, service) => String(service.serviceId).localeCompare(String(chosen.serviceId)) < 0 ? service : chosen) : undefined;
    if (requestedServiceId && !selected) throw new BadRequestException("The selected service is not part of the authoritative LIVE generation.");
    const selectedString = (key: string) => typeof selected?.[key] === "string" ? String(selected[key]) : "";
    const serviceId = selectedString("serviceId");
    const cacheKey = `${project.id}:${serviceId}`;
    const cached = this.cache.get(cacheKey);
    if (cached?.value.generationId === release.generationId && cached.expiresAt > Date.now()) return cached.value;
    const cluster = selectedString("ecsClusterArn") || selectedString("ecsClusterName") || string("ecsClusterArn") || string("ecsClusterName");
    const serviceArn = selectedString("ecsServiceArn");
    const taskDefinitionArn = selectedString("taskDefinitionArn");
    const targetGroupArn = selectedString("targetGroupArn");
    const expectedLogGroup = selectedString("cloudWatchLogGroupName");
    const expectedContainerName = selectedString("applicationContainerName");
    if (!generation || !serviceId || !cluster || !serviceArn || !taskDefinitionArn || !targetGroupArn || !expectedLogGroup || !expectedContainerName) {
      throw new RuntimeIdentityUnavailableException("The authoritative LIVE runtime identity is incomplete.");
    }

    const region = selectedString("region") || string("region") || this.config.get<string>("AWS_REGION", "us-east-1");
    const ecs = this.ecs(region);
    const elb = this.elb(region);
    const resolved = await Promise.allSettled([
      ecs.send(new DescribeServicesCommand({ cluster, services: [serviceArn] })),
      ecs.send(new DescribeTaskDefinitionCommand({ taskDefinition: taskDefinitionArn })),
      elb.send(new DescribeTargetGroupsCommand({ TargetGroupArns: [targetGroupArn] })),
      ecs.send(new ListTasksCommand({ cluster, serviceName: serviceArn, desiredStatus: "RUNNING" })),
      elb.send(new DescribeTargetHealthCommand({ TargetGroupArn: targetGroupArn })),
    ]);
    const unexpected = resolved.find((result) => result.status === "rejected" && !this.isExpectedRuntimeAbsence(result.reason));
    if (unexpected?.status === "rejected") throw new AwsRuntimeUnavailableException("AWS ECS/ALB runtime observation is temporarily unavailable.");
    if (resolved.some((result) => result.status === "rejected")) {
      this.cache.delete(cacheKey);
      throw new AwsRuntimeUnavailableException("The previously authoritative LIVE runtime is no longer present in AWS.");
    }
    const [serviceResult, taskDefinitionResult, targetGroupResult, taskResult, healthResult] = resolved.map(
      (result) => (result as PromiseFulfilledResult<any>).value,
    );
    const service = serviceResult.services?.[0];
    const taskDefinition = taskDefinitionResult.taskDefinition;
    const targetGroup = targetGroupResult.TargetGroups?.[0];
    if (
      !service?.serviceArn
      || service.status !== "ACTIVE"
      || service.taskDefinition !== taskDefinitionArn
      || !targetGroup?.TargetGroupArn
      || targetGroup.TargetGroupArn !== targetGroupArn
      || !targetGroup.LoadBalancerArns?.[0]
    ) {
      throw new AwsRuntimeUnavailableException("AWS does not match the authoritative LIVE release identity.");
    }
    const appContainer = taskDefinition?.containerDefinitions?.find((container) => container.name === expectedContainerName);
    const logOptions = appContainer?.logConfiguration?.options || {};
    if (appContainer?.name !== expectedContainerName || logOptions["awslogs-group"] !== expectedLogGroup) {
      throw new AwsRuntimeUnavailableException("The LIVE task definition does not contain the verified Railpack log identity.");
    }
    const value: LiveRuntimeIdentity = {
      projectId: project.id,
      environmentName,
      generationId: generation.id,
      releaseId: release.id,
      operationId: release.deployedByPipelineRunId || null,
      serviceId,
      serviceDisplayName: selectedString("serviceName") || service.serviceName || "Web",
      publicUrl: selectedString("publicUrl") || null,
      region,
      cluster,
      clusterName: cluster.split("/").pop() || cluster,
      serviceArn: service.serviceArn,
      serviceName: service.serviceName || serviceArn.split("/").pop() || "",
      taskDefinitionArn,
      taskArns: taskResult.taskArns || [],
      targetGroupArn,
      loadBalancerArn: targetGroup.LoadBalancerArns[0],
      logGroupName: expectedLogGroup,
      logStreamPrefix: logOptions["awslogs-stream-prefix"] || "ecs",
      containerName: expectedContainerName,
      resolvedAt: new Date().toISOString(),
      targetHealth: (healthResult.TargetHealthDescriptions || []).map((item) => item.TargetHealth?.State || "unknown"),
    };
    this.cache.set(cacheKey, { value, expiresAt: Date.now() + 20_000 });
    return value;
  }

  protected ecs(region: string) { return new ECSClient({ region }); }
  protected elb(region: string) { return new ElasticLoadBalancingV2Client({ region }); }
  private isExpectedRuntimeAbsence(error: unknown) {
    const name = String((error as { name?: unknown })?.name || "");
    return [
      "TargetGroupNotFoundException",
      "TargetGroupNotFound",
      "RuleNotFoundException",
      "ServiceNotFoundException",
      "ClusterNotFoundException",
      "ResourceNotFoundException",
    ].includes(name);
  }
}
