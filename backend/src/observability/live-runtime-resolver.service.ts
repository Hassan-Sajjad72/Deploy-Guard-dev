import { Injectable, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
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

export type LiveRuntimeIdentity = {
  projectId: string;
  environmentName: string;
  generationId: string;
  releaseId: string;
  operationId: string | null;
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

@Injectable()
export class LiveRuntimeResolverService {
  private readonly cache = new Map<string, { expiresAt: number; value: LiveRuntimeIdentity }>();

  constructor(
    @InjectRepository(Project) private readonly projects: Repository<Project>,
    @InjectRepository(ProjectDeploymentGeneration) private readonly generations: Repository<ProjectDeploymentGeneration>,
    @InjectRepository(ProjectStableRelease) private readonly releases: Repository<ProjectStableRelease>,
    private readonly config: ConfigService,
  ) {}

  async resolveForUser(user: User, projectId: string) {
    const project = await this.projects.findOne({ where: { id: projectId } });
    if (!project || project.status === ProjectStatus.ARCHIVED) throw new NotFoundException("Project not found");
    const canView = user.role === UserRole.ADMIN
      || project.ownerUserId === user.id
      || (user.role === UserRole.READONLY && project.visibility === "workspace");
    if (!canView) throw new NotFoundException("Project not found");
    return this.resolveProject(project);
  }

  async resolveProjectId(projectId: string) {
    const project = await this.projects.findOne({ where: { id: projectId } });
    if (!project || project.status === ProjectStatus.ARCHIVED) throw new NotFoundException("Project not found");
    return this.resolveProject(project);
  }

  async liveProjectIds() {
    const rows = await this.releases.find({
      where: { status: StableReleaseStatus.STABLE },
      select: { projectId: true, generationId: true },
    });
    return [...new Set(rows.filter((row) => row.generationId).map((row) => row.projectId))];
  }

  invalidate(projectId: string) {
    this.cache.delete(projectId);
  }

  private async resolveProject(project: Project): Promise<LiveRuntimeIdentity> {
    const environmentName = canonicalEnvironmentName(project);
    const release = await this.releases.findOne({
      where: { projectId: project.id, environmentName, status: StableReleaseStatus.STABLE },
      order: { deployedAt: "DESC" },
    });
    if (!release?.generationId || !release.ecsServiceArn || !release.taskDefinitionArn) {
      throw new ServiceUnavailableException("No authoritative LIVE runtime is available for this project.");
    }
    const cached = this.cache.get(project.id);
    if (cached?.value.generationId === release.generationId && cached.expiresAt > Date.now()) return cached.value;

    const generation = await this.generations.findOne({
      where: {
        id: release.generationId,
        projectId: project.id,
        environmentName,
        status: DeploymentGenerationStatus.LIVE,
      },
    });
    const targetGroupArn = typeof release.metadata?.targetGroupArn === "string" ? release.metadata.targetGroupArn : "";
    const cluster = this.config.get<string>("DEPLOYGUARD_SHARED_ECS_CLUSTER_ARN", "")
      || this.config.get<string>("DEPLOYGUARD_SHARED_ECS_CLUSTER_NAME", "");
    if (!generation || !cluster || !targetGroupArn) {
      throw new ServiceUnavailableException("The authoritative LIVE runtime identity is incomplete.");
    }

    const region = this.config.get<string>("AWS_REGION", "us-east-1");
    const ecs = this.ecs(region);
    const elb = this.elb(region);
    const resolved = await Promise.allSettled([
      ecs.send(new DescribeServicesCommand({ cluster, services: [release.ecsServiceArn] })),
      ecs.send(new DescribeTaskDefinitionCommand({ taskDefinition: release.taskDefinitionArn })),
      elb.send(new DescribeTargetGroupsCommand({ TargetGroupArns: [targetGroupArn] })),
      ecs.send(new ListTasksCommand({ cluster, serviceName: release.ecsServiceArn, desiredStatus: "RUNNING" })),
      elb.send(new DescribeTargetHealthCommand({ TargetGroupArn: targetGroupArn })),
    ]);
    const unexpected = resolved.find((result) => result.status === "rejected" && !this.isExpectedRuntimeAbsence(result.reason));
    if (unexpected?.status === "rejected") throw unexpected.reason;
    if (resolved.some((result) => result.status === "rejected")) {
      this.cache.delete(project.id);
      throw new ServiceUnavailableException("The previously authoritative LIVE runtime is no longer present in AWS.");
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
      || service.taskDefinition !== release.taskDefinitionArn
      || !targetGroup?.TargetGroupArn
      || targetGroup.TargetGroupArn !== targetGroupArn
      || !targetGroup.LoadBalancerArns?.[0]
    ) {
      throw new ServiceUnavailableException("AWS does not match the authoritative LIVE release identity.");
    }
    const appContainer = taskDefinition?.containerDefinitions?.find((container) => container.name === "app")
      || taskDefinition?.containerDefinitions?.[0];
    const logOptions = appContainer?.logConfiguration?.options || {};
    const expectedLogGroup = `/deployguard/${project.id}/${environmentName}/${generation.id}/app`;
    if (logOptions["awslogs-group"] !== expectedLogGroup) {
      throw new ServiceUnavailableException("The LIVE task definition does not contain the expected generation log group.");
    }
    const value: LiveRuntimeIdentity = {
      projectId: project.id,
      environmentName,
      generationId: generation.id,
      releaseId: release.id,
      operationId: release.deployedByPipelineRunId || null,
      region,
      cluster,
      clusterName: cluster.split("/").pop() || cluster,
      serviceArn: service.serviceArn,
      serviceName: service.serviceName || release.ecsServiceArn.split("/").pop() || "",
      taskDefinitionArn: release.taskDefinitionArn,
      taskArns: taskResult.taskArns || [],
      targetGroupArn,
      loadBalancerArn: targetGroup.LoadBalancerArns[0],
      logGroupName: expectedLogGroup,
      logStreamPrefix: logOptions["awslogs-stream-prefix"] || "ecs",
      containerName: appContainer?.name || "app",
      resolvedAt: new Date().toISOString(),
      targetHealth: (healthResult.TargetHealthDescriptions || []).map((item) => item.TargetHealth?.State || "unknown"),
    };
    this.cache.set(project.id, { value, expiresAt: Date.now() + 20_000 });
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
