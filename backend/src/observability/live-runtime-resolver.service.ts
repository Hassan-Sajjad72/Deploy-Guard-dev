import { canAccessProject } from "../workspaces/project-access";
import { BadRequestException, Injectable, NotFoundException, Optional, ServiceUnavailableException } from "@nestjs/common";
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
  DescribeLoadBalancersCommand,
  DescribeTargetHealthCommand,
  DescribeTagsCommand,
  ElasticLoadBalancingV2Client,
} from "@aws-sdk/client-elastic-load-balancing-v2";
import { Repository } from "typeorm";
import { ProjectStableRelease, StableReleaseStatus } from "../orchestration/project-stable-release.entity";
import { canonicalEnvironmentName } from "../projects/canonical-environment";
import { DeploymentGenerationStatus, ProjectDeploymentGeneration } from "../projects/project-deployment-generation.entity";
import { Project, ProjectStatus } from "../projects/project.entity";
import { resolveApplicationEntrypointServiceId } from "../projects/application-entrypoint";
import { User, UserRole } from "../users/user.entity";
import { LiveRuntimeIdentityRecoveryService } from "../projects/current-state/live-runtime-identity-recovery.service";
import { CustomerRuntimeEvidenceService } from "../operational-intelligence/customer-runtime-evidence.service";

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
  executionMode?: "customer" | "legacy_control_plane";
  desiredCount?: number;
  runningCount?: number;
  pendingCount?: number;
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
    @Optional() private readonly customerRuntime?: CustomerRuntimeEvidenceService,
  ) {}

  async resolveForUser(user: User, projectId: string, serviceId?: string) {
    return this.resolveProject(await this.assertAccessForUser(user, projectId), serviceId);
  }

  async assertAccessForUser(user: User, projectId: string) {
    const project = await this.projects.findOne({ where: { id: projectId } });
    if (!project || project.status === ProjectStatus.ARCHIVED) throw new NotFoundException("Project not found");
    const canView = canAccessProject(user, project);
    if (!canView) throw new NotFoundException("Project not found");
    return project;
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

  async resolveAllProjectServices(projectId: string) {
    const project = await this.projects.findOne({ where: { id: projectId } });
    if (!project || project.status === ProjectStatus.ARCHIVED) throw new NotFoundException("Project not found");
    const manifest = await this.runtimeIdentityRecovery.recover(project) || {};
    const services = Array.isArray(manifest.services)
      ? manifest.services.filter((value): value is Record<string, unknown> => Boolean(value) && typeof value === "object")
      : [];
    const serviceIds = [...new Set(services.flatMap((service) => typeof service.serviceId === "string" && service.serviceId ? [service.serviceId] : []))];
    if (!serviceIds.length) return [await this.resolveProject(project)];
    const resolved = await Promise.allSettled(serviceIds.map((serviceId) => this.resolveProject(project, serviceId)));
    return resolved.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
  }

  invalidate(projectId: string) {
    for (const key of this.cache.keys()) if (key === projectId || key.startsWith(`${projectId}:`)) this.cache.delete(key);
  }

  async withRuntimeRead<T>(identity: LiveRuntimeIdentity, read: (context: { region: string; credentials?: { accessKeyId: string; secretAccessKey: string; sessionToken: string } }) => Promise<T>): Promise<T> {
    const project = await this.projects.findOne({ where: { id: identity.projectId } });
    if (!project || project.status === ProjectStatus.ARCHIVED) throw new NotFoundException("Project not found");
    if (project.executionMode !== "customer") {
      if (project.executionMode !== "legacy_control_plane" || identity.executionMode === "customer") throw new RuntimeIdentityUnavailableException("Runtime account authority changed.");
      return read({ region: identity.region });
    }
    if (!this.customerRuntime || identity.executionMode !== "customer") throw new RuntimeIdentityUnavailableException("Account-scoped customer runtime evidence is required.");
    return this.customerRuntime.withVerifiedRuntimeRead(project, identity.serviceId, async (scope) => {
      if ([scope.credentials?.accessKeyId, scope.credentials?.secretAccessKey, scope.credentials?.sessionToken].some((value) => typeof value !== "string" || !value)) throw new RuntimeIdentityUnavailableException("Temporary customer read credentials are unavailable.");
      if (scope.region !== identity.region || scope.releaseId !== identity.releaseId || scope.generationId !== identity.generationId || scope.identity.ecsServiceArn !== identity.serviceArn || scope.identity.taskDefinitionArn !== identity.taskDefinitionArn || scope.identity.cloudWatchLogGroupName !== identity.logGroupName) throw new RuntimeIdentityUnavailableException("Customer runtime changed before observation.");
      if (scope.logConfiguration.logDriver !== "awslogs" || scope.logConfiguration.options["awslogs-group"] !== identity.logGroupName || scope.logConfiguration.options["awslogs-region"] !== scope.region) throw new RuntimeIdentityUnavailableException("Customer log destination changed before observation.");
      return read({ region: scope.region, credentials: scope.credentials });
    });
  }

  private async resolveCustomerProject(project: Project, requestedServiceId?: string): Promise<LiveRuntimeIdentity> {
    if (!this.customerRuntime) throw new RuntimeIdentityUnavailableException("Account-scoped customer runtime verification is unavailable.");
    const manifest = await this.runtimeIdentityRecovery.recover(project) || {};
    const services = Array.isArray(manifest.services) ? manifest.services : [];
    const serviceId = requestedServiceId || resolveApplicationEntrypointServiceId(project.applicationEntryPointServiceId, services);
    if (!serviceId || !services.some((service: any) => service.serviceId === serviceId)) throw new RuntimeIdentityUnavailableException("The authoritative customer service revision is unavailable.");
    return this.customerRuntime.withVerifiedRuntimeRead(project, serviceId, async (scope) => {
      const identity = scope.identity, signal = AbortSignal.timeout(15_000);
      const expectedGroup = `/deployguard/${project.id}/services/${serviceId}`;
      const albPrefix = `arn:aws:elasticloadbalancing:${scope.region}:${scope.accountId}:`;
      const options = scope.logConfiguration.options;
      if (identity.cloudWatchLogGroupName !== expectedGroup || scope.logConfiguration.logDriver !== "awslogs" || options["awslogs-group"] !== expectedGroup || options["awslogs-region"] !== scope.region || !options["awslogs-stream-prefix"] || !String(identity.targetGroupArn || "").startsWith(`${albPrefix}targetgroup/`) || !String(identity.albArn || "").startsWith(`${albPrefix}loadbalancer/app/`)) throw new RuntimeIdentityUnavailableException("Customer log or load-balancer scope differs from the owned release.");
      const ecs = new ECSClient({ region: scope.region, credentials: scope.credentials, maxAttempts: 1 });
      const elb = new ElasticLoadBalancingV2Client({ region: scope.region, credentials: scope.credentials, maxAttempts: 1 });
      try {
        const [tasks, groups, health, service, tags, loadBalancers] = await Promise.all([
          ecs.send(new ListTasksCommand({ cluster: identity.ecsClusterArn, serviceName: identity.ecsServiceArn, desiredStatus: "RUNNING" }), { abortSignal: signal }),
          elb.send(new DescribeTargetGroupsCommand({ TargetGroupArns: [identity.targetGroupArn] }), { abortSignal: signal }),
          elb.send(new DescribeTargetHealthCommand({ TargetGroupArn: identity.targetGroupArn }), { abortSignal: signal }),
          ecs.send(new DescribeServicesCommand({ cluster: identity.ecsClusterArn, services: [identity.ecsServiceArn] }), { abortSignal: signal }),
          elb.send(new DescribeTagsCommand({ ResourceArns: [identity.albArn, identity.targetGroupArn] }), { abortSignal: signal }),
          elb.send(new DescribeLoadBalancersCommand({ LoadBalancerArns: [identity.albArn] }), { abortSignal: signal }),
        ]);
        const group = groups.TargetGroups?.[0];
        const owns = (arn: string) => { const entry = tags.TagDescriptions?.find((item) => item.ResourceArn === arn); return entry?.Tags?.some((tag) => tag.Key === "ManagedBy" && tag.Value === "DeployGuard") && entry.Tags.some((tag) => tag.Key === "DeployGuardProjectId" && tag.Value === project.id); };
        let url: URL;
        try { url = new URL(identity.publicUrl); } catch { throw new RuntimeIdentityUnavailableException("Customer application origin is unavailable."); }
        const lb = loadBalancers.LoadBalancers?.[0];
        if (!owns(identity.albArn) || !owns(identity.targetGroupArn) || lb?.LoadBalancerArn !== identity.albArn || url.hostname !== lb.DNSName || url.username || url.password || url.port || url.search || url.hash || !["http:", "https:"].includes(url.protocol) || url.pathname !== "/" || group?.TargetGroupArn !== identity.targetGroupArn || !group.LoadBalancerArns?.includes(identity.albArn) || !service.services?.[0]?.loadBalancers?.some((attachment) => attachment.targetGroupArn === identity.targetGroupArn && attachment.containerName === identity.applicationContainerName)) throw new RuntimeIdentityUnavailableException("Customer log or load-balancer routing differs from the owned release.");
        return { projectId: project.id, environmentName: canonicalEnvironmentName(project), generationId: scope.generationId, releaseId: scope.releaseId, operationId: scope.operationId,
          serviceId, serviceDisplayName: services.find((entry: any) => entry.serviceId === serviceId)?.serviceName || serviceId, publicUrl: identity.publicUrl || null,
          region: scope.region, cluster: identity.ecsClusterArn, clusterName: identity.ecsClusterArn.split("/").pop(), serviceArn: identity.ecsServiceArn, serviceName: identity.ecsServiceArn.split("/").pop(),
          taskDefinitionArn: identity.taskDefinitionArn, taskArns: tasks.taskArns || [], targetGroupArn: identity.targetGroupArn, loadBalancerArn: identity.albArn,
          logGroupName: expectedGroup, logStreamPrefix: options["awslogs-stream-prefix"], containerName: identity.applicationContainerName, resolvedAt: new Date().toISOString(),
          targetHealth: (health.TargetHealthDescriptions || []).map((entry) => entry.TargetHealth?.State || "unknown"), executionMode: "customer", desiredCount: service.services?.[0]?.desiredCount, runningCount: service.services?.[0]?.runningCount, pendingCount: service.services?.[0]?.pendingCount };
      } finally { ecs.destroy(); elb.destroy(); }
    });
  }

  private async resolveProject(project: Project, requestedServiceId?: string): Promise<LiveRuntimeIdentity> {
    if (project.executionMode === "customer") return this.resolveCustomerProject(project, requestedServiceId);
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
    const defaultServiceId = resolveApplicationEntrypointServiceId(
      project.applicationEntryPointServiceId,
      persistedServices,
    );
    const selectedServiceId = requestedServiceId || defaultServiceId;
    const selected = selectedServiceId
      ? persistedServices.find((service) => service.serviceId === selectedServiceId)
      : undefined;
    if (requestedServiceId && !selected) throw new BadRequestException("The selected service is not part of the authoritative LIVE generation.");
    if (!requestedServiceId && !selected) throw new RuntimeIdentityUnavailableException("The authoritative application entrypoint service is unavailable in the LIVE generation.");
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
      executionMode: "legacy_control_plane",
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
