import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectRepository } from "@nestjs/typeorm";
import {
  DescribeTaskDefinitionCommand,
  DescribeTasksCommand,
  DescribeServicesCommand,
  ECSClient,
  ListTasksCommand,
  UpdateServiceCommand,
} from "@aws-sdk/client-ecs";
import { DescribeImagesCommand, ECRClient } from "@aws-sdk/client-ecr";
import {
  DescribeTargetGroupsCommand,
  DescribeTargetHealthCommand,
  ElasticLoadBalancingV2Client,
} from "@aws-sdk/client-elastic-load-balancing-v2";
import {
  CloudWatchLogsClient,
  DescribeLogStreamsCommand,
  GetLogEventsCommand,
} from "@aws-sdk/client-cloudwatch-logs";
import { Repository } from "typeorm";
import { AuditLogService } from "../audit-log/audit-log.service";
import { ProjectDeployment, ProjectDeploymentStatus } from "./project-deployment.entity";
import { ProjectOrchestrationEvent } from "./project-orchestration-event.entity";
import { getOrchestrationConfig } from "./orchestration.config";

type ServiceStabilityResult = {
  stable: boolean;
  reason?: string;
  serviceArn: string | null;
  desiredCount: number;
  runningCount: number;
  pendingCount: number;
  rolloutState: string | null;
  deployments: Record<string, unknown>[];
  diagnostics?: EcsFailureDiagnostics;
  checkedAt: string;
};

type EcsFailureDiagnostics = {
  diagnosticCode: string;
  rootCause: string;
  platformFix: string;
  userMessage: string;
  summary: string;
  stoppedTaskReason: string | null;
  containerExitCode: number | null;
  containerReason: string | null;
  lastStoppedTaskArn: string | null;
  taskEvents: string[];
  targetHealth: Record<string, unknown>[];
  logGroupName: string | null;
  logStreamName: string | null;
  logLines: string[];
  containerPort: number | null;
  targetPort: number | null;
  healthCheckPath: string | null;
};

type DeploymentConfigurationCheck = {
  name: string;
  passed: boolean;
  message: string;
};

@Injectable()
export class EcsService {
  constructor(
    @InjectRepository(ProjectDeployment)
    private readonly deploymentRepository: Repository<ProjectDeployment>,
    @InjectRepository(ProjectOrchestrationEvent)
    private readonly eventRepository: Repository<ProjectOrchestrationEvent>,
    private readonly config: ConfigService,
    private readonly auditLogService: AuditLogService
  ) {}

  async createOrUpdateCluster(projectId: string, environmentName = "dev") {
    return { projectId, environmentName, status: "terraform_managed" };
  }

  async registerTaskDefinition(projectId: string, imageUri: string, runtimeConfiguration: Record<string, unknown>) {
    return { projectId, imageUri, runtimeConfiguration, status: "terraform_managed" };
  }

  async createOrUpdateService(projectId: string, taskDefinitionArn: string, infrastructureOutputs: Record<string, unknown>) {
    return { projectId, taskDefinitionArn, infrastructureOutputs, status: "terraform_managed" };
  }

  async waitForServiceStability(projectId: string, serviceArn?: string | null): Promise<ServiceStabilityResult> {
    const deployment = await this.getServiceStatus(projectId);
    const orchestrationConfig = getOrchestrationConfig(this.config);
    const timeoutMs = orchestrationConfig.serviceStabilityTimeoutSeconds * 1000;
    const pollMs = orchestrationConfig.serviceStabilityPollIntervalSeconds * 1000;
    const startedAt = Date.now();
    const cluster = deployment?.ecsClusterArn || deployment?.ecsClusterName;
    const service = serviceArn || deployment?.ecsServiceArn || deployment?.ecsServiceName;

    await this.event(projectId, deployment?.pipelineRunId || null, deployment?.id || null, "ecs_service_stability_wait_started", "running", "Waiting for ECS service stability.");
    await this.audit("ECS_SERVICE_STABILITY_WAIT_STARTED", projectId, "success", { deploymentId: deployment?.id });

    if (!cluster || !service) {
      const missing = this.unstableResult(service || null, "ECS cluster or service is missing.");
      await this.event(projectId, deployment?.pipelineRunId || null, deployment?.id || null, "ecs_service_stability_failed", "failed", missing.reason!, missing);
      await this.audit("ECS_SERVICE_STABILITY_FAILED", projectId, "failed", missing);
      return missing;
    }

    while (Date.now() - startedAt <= timeoutMs) {
      let result: ServiceStabilityResult;

      try {
        result = await this.describeServiceStability(projectId, cluster, service, deployment);
      } catch (error) {
        result = this.unstableResult(service, this.failureReason(error, "Failed to describe ECS service stability."));
        await this.event(projectId, deployment?.pipelineRunId || null, deployment?.id || null, "ecs_service_stability_failed", "failed", result.reason!, result);
        await this.audit("ECS_SERVICE_STABILITY_FAILED", projectId, "failed", result);
        return result;
      }

      await this.event(projectId, deployment?.pipelineRunId || null, deployment?.id || null, "ecs_service_stability_check", result.stable ? "success" : "running", result.reason || "ECS service stability checked.", result);
      await this.audit("ECS_SERVICE_STABILITY_CHECKED", projectId, "success", result);

      if (result.stable) {
        await this.event(projectId, deployment?.pipelineRunId || null, deployment?.id || null, "ecs_service_stable", "success", "ECS service reached stable state.", result);
        await this.audit("ECS_SERVICE_STABLE", projectId, "success", result);
        return result;
      }

      if (result.rolloutState === "FAILED") {
        const diagnostics = await this.collectFailureDiagnostics(cluster, service, deployment).catch(() => null);
        if (diagnostics) {
          result.diagnostics = diagnostics;
          result.reason = diagnostics.summary;
        }
        await this.event(projectId, deployment?.pipelineRunId || null, deployment?.id || null, "ecs_service_deployment_failed", "failed", result.reason || "ECS service deployment failed.", result);
        await this.audit("ECS_SERVICE_DEPLOYMENT_FAILED", projectId, "failed", result);
        return result;
      }

      await this.sleep(pollMs);
    }

    const timeout = this.unstableResult(service, "Timed out waiting for ECS service stability.");
    await this.event(projectId, deployment?.pipelineRunId || null, deployment?.id || null, "ecs_service_stability_timeout", "failed", timeout.reason!, timeout);
    await this.audit("ECS_SERVICE_STABILITY_TIMEOUT", projectId, "failed", timeout);
    return timeout;
  }

  async getServiceStatus(projectId: string) {
    return this.deploymentRepository.findOne({
      where: { projectId },
      order: { createdAt: "DESC" },
    });
  }

  async forceNewDeployment(projectId: string) {
    const deployment = await this.getServiceStatus(projectId);
    const cluster = deployment?.ecsClusterArn || deployment?.ecsClusterName;
    const service = deployment?.ecsServiceArn || deployment?.ecsServiceName;

    if (!cluster || !service) {
      throw new Error("ECS cluster or service is missing for force deployment.");
    }

    const response = await this.ecsClient().send(
      new UpdateServiceCommand({
        cluster,
        service,
        forceNewDeployment: true,
        desiredCount: deployment?.desiredCount || undefined,
      })
    );

    return {
      projectId,
      deploymentId: deployment?.id || null,
      status: "force_deployment_requested",
      serviceArn: response.service?.serviceArn || deployment?.ecsServiceArn || null,
    };
  }

  async updateServiceToTaskDefinition(projectId: string, taskDefinitionArn: string) {
    const deployment = await this.getServiceStatus(projectId);
    const cluster = deployment?.ecsClusterArn || deployment?.ecsClusterName;
    const service = deployment?.ecsServiceArn || deployment?.ecsServiceName;

    if (deployment) {
      if (!cluster || !service) {
        throw new Error("ECS cluster or service is missing for rollback update.");
      }

      await this.ecsClient().send(
        new UpdateServiceCommand({
          cluster,
          service,
          taskDefinition: taskDefinitionArn,
          forceNewDeployment: true,
        })
      );
      deployment.previousTaskDefinitionArn = deployment.taskDefinitionArn;
      deployment.taskDefinitionArn = taskDefinitionArn;
      deployment.status = ProjectDeploymentStatus.ROLLBACK_STARTED;
      await this.deploymentRepository.save(deployment);
    }

    return { projectId, taskDefinitionArn, status: "service_update_requested" };
  }

  async getTaskEvents(projectId: string) {
    const deployment = await this.getServiceStatus(projectId);
    return deployment?.metadata?.taskEvents || [];
  }

  async getFailureDiagnostics(projectId: string) {
    const deployment = await this.getServiceStatus(projectId);
    const cluster = deployment?.ecsClusterArn || deployment?.ecsClusterName;
    const service = deployment?.ecsServiceArn || deployment?.ecsServiceName;
    if (!deployment || !cluster || !service) return null;
    return this.collectFailureDiagnostics(cluster, service, deployment);
  }

  async validateDeploymentConfiguration(deployment: ProjectDeployment) {
    const checks: DeploymentConfigurationCheck[] = [];
    const taskDefinition = deployment.taskDefinitionArn
      ? (await this.ecsClient().send(new DescribeTaskDefinitionCommand({
          taskDefinition: deployment.taskDefinitionArn,
        }))).taskDefinition
      : null;
    const container = taskDefinition?.containerDefinitions?.find(
      (item) => item.name === "app"
    ) || taskDefinition?.containerDefinitions?.[0];
    const containerPort = container?.portMappings?.[0]?.containerPort || null;

    checks.push({
      name: "task_definition_image",
      passed: Boolean(container?.image && container.image === deployment.imageUri),
      message: container?.image === deployment.imageUri
        ? "Task definition uses the pipeline ECR image."
        : "Task definition image does not match the pipeline ECR image URI.",
    });
    checks.push({
      name: "network_mode",
      passed: taskDefinition?.networkMode === "awsvpc",
      message: taskDefinition?.networkMode === "awsvpc"
        ? "Task definition uses awsvpc networking."
        : "Fargate task definition must use awsvpc networking.",
    });
    checks.push({
      name: "fargate_resources",
      passed: this.validFargateResources(taskDefinition?.cpu, taskDefinition?.memory),
      message: this.validFargateResources(taskDefinition?.cpu, taskDefinition?.memory)
        ? `Fargate CPU/memory ${taskDefinition?.cpu}/${taskDefinition?.memory} is valid.`
        : "Task definition has an invalid Fargate CPU/memory combination.",
    });
    checks.push({
      name: "container_port",
      passed: Boolean(containerPort && containerPort === deployment.appPort),
      message: containerPort === deployment.appPort
        ? `Container port ${containerPort} matches the deployment port.`
        : `Container port ${containerPort || "missing"} does not match deployment port ${deployment.appPort || "missing"}.`,
    });

    let targetPort: number | null = null;
    let targetHealthPath: string | null = null;
    if (deployment.targetGroupArn) {
      const targetGroup = (await this.elbClient().send(
        new DescribeTargetGroupsCommand({ TargetGroupArns: [deployment.targetGroupArn] })
      )).TargetGroups?.[0];
      targetPort = targetGroup?.Port || null;
      targetHealthPath = targetGroup?.HealthCheckPath || null;
    }
    checks.push({
      name: "target_group_port",
      passed: Boolean(targetPort && targetPort === containerPort),
      message: targetPort === containerPort
        ? `ALB target group forwards to container port ${containerPort}.`
        : `ALB target group port ${targetPort || "missing"} does not match container port ${containerPort || "missing"}.`,
    });
    checks.push({
      name: "health_check_path",
      passed: Boolean(targetHealthPath && targetHealthPath === deployment.healthCheckPath),
      message: targetHealthPath === deployment.healthCheckPath
        ? `ALB health check path is ${targetHealthPath}.`
        : `ALB health check path ${targetHealthPath || "missing"} does not match deployment path ${deployment.healthCheckPath || "missing"}.`,
    });

    const image = this.parseEcrImage(deployment.imageUri);
    let imageExists = false;
    if (image) {
      try {
        const response = await this.ecrClient().send(new DescribeImagesCommand({
          repositoryName: image.repositoryName,
          imageIds: [image.digest ? { imageDigest: image.digest } : { imageTag: image.tag! }],
        }));
        imageExists = Boolean(response.imageDetails?.length);
      } catch {
        imageExists = false;
      }
    }
    checks.push({
      name: "ecr_image",
      passed: imageExists,
      message: imageExists
        ? "Container image exists in ECR."
        : "Container image was not found in ECR or cannot be accessed.",
    });

    const environmentKeys = (container?.environment || []).map((item) => item.name).filter(Boolean) as string[];
    return {
      passed: checks.every((check) => check.passed),
      checks,
      containerPort,
      targetPort,
      healthCheckPath: targetHealthPath,
      environmentKeys,
      warnings: environmentKeys.length
        ? []
        : ["Task definition contains no runtime environment variables. Confirm the application does not require any before deployment."],
      checkedAt: new Date().toISOString(),
    };
  }

  private async describeServiceStability(
    projectId: string,
    cluster: string,
    service: string,
    deployment: ProjectDeployment | null
  ): Promise<ServiceStabilityResult> {
    const response = await this.ecsClient().send(
      new DescribeServicesCommand({
        cluster,
        services: [service],
      })
    );
    const described = response.services?.[0];

    if (!described) {
      return this.unstableResult(service, "ECS service was not found.");
    }

    const deployments = (described.deployments || []).map((item) => ({
      id: item.id || null,
      status: item.status || null,
      rolloutState: item.rolloutState || null,
      desiredCount: item.desiredCount || 0,
      runningCount: item.runningCount || 0,
      pendingCount: item.pendingCount || 0,
      taskDefinition: item.taskDefinition || null,
      updatedAt: item.updatedAt?.toISOString() || null,
    }));
    const primary = (described.deployments || []).find((item) => item.status === "PRIMARY");
    const failed = (described.deployments || []).find((item) => item.rolloutState === "FAILED");
    const desiredCount = described.desiredCount || 0;
    const runningCount = described.runningCount || 0;
    const pendingCount = described.pendingCount || 0;
    const rolloutState = failed?.rolloutState || primary?.rolloutState || null;
    const serviceActive = described.status === "ACTIVE";
    const primaryComplete = !primary?.rolloutState || primary.rolloutState === "COMPLETED";
    const stable = serviceActive && runningCount >= desiredCount && pendingCount === 0 && primaryComplete && !failed;
    const reason = stable
      ? undefined
      : failed
        ? failed.rolloutStateReason || "ECS deployment rollout failed."
        : "ECS service is not stable yet.";

    return {
      stable,
      reason,
      serviceArn: described.serviceArn || deployment?.ecsServiceArn || service || null,
      desiredCount,
      runningCount,
      pendingCount,
      rolloutState,
      deployments,
      checkedAt: new Date().toISOString(),
    };
  }

  private unstableResult(serviceArn: string | null, reason: string): ServiceStabilityResult {
    return {
      stable: false,
      reason,
      serviceArn,
      desiredCount: 0,
      runningCount: 0,
      pendingCount: 0,
      rolloutState: null,
      deployments: [],
      checkedAt: new Date().toISOString(),
    };
  }

  private ecsClient() {
    return new ECSClient({
      region: this.config.get<string>("AWS_REGION", "us-east-1"),
    });
  }

  private ecrClient() {
    return new ECRClient({ region: this.config.get<string>("AWS_REGION", "us-east-1") });
  }

  private elbClient() {
    return new ElasticLoadBalancingV2Client({
      region: this.config.get<string>("AWS_REGION", "us-east-1"),
    });
  }

  private logsClient() {
    return new CloudWatchLogsClient({
      region: this.config.get<string>("AWS_REGION", "us-east-1"),
    });
  }

  private async collectFailureDiagnostics(
    cluster: string,
    service: string,
    deployment: ProjectDeployment | null
  ): Promise<EcsFailureDiagnostics> {
    const taskArns = (await this.ecsClient().send(new ListTasksCommand({
      cluster,
      serviceName: service,
      desiredStatus: "STOPPED",
      maxResults: 20,
    }))).taskArns || [];
    const tasks = taskArns.length
      ? (await this.ecsClient().send(new DescribeTasksCommand({
          cluster,
          tasks: taskArns,
        }))).tasks || []
      : [];
    const deploymentStartedAt = deployment?.createdAt?.getTime() || 0;
    const currentTasks = tasks.filter((task) => {
      const sameDefinition = !deployment?.taskDefinitionArn || task.taskDefinitionArn === deployment.taskDefinitionArn;
      const belongsToDeployment = !deploymentStartedAt || (task.startedAt?.getTime() || task.createdAt?.getTime() || 0) >= deploymentStartedAt - 60_000;
      return sameDefinition && belongsToDeployment;
    });
    const latestTask = [...currentTasks].sort(
      (left, right) => (right.stoppedAt?.getTime() || 0) - (left.stoppedAt?.getTime() || 0)
    )[0];
    const container = latestTask?.containers?.find((item) => item.name === "app") || latestTask?.containers?.[0];
    const serviceDescription = (await this.ecsClient().send(new DescribeServicesCommand({
      cluster,
      services: [service],
    }))).services?.[0];
    const taskEvents = (serviceDescription?.events || [])
      .slice(0, 12)
      .map((item) => this.sanitize(item.message || ""));

    const targetHealth = deployment?.targetGroupArn
      ? (await this.elbClient().send(new DescribeTargetHealthCommand({
          TargetGroupArn: deployment.targetGroupArn,
        }))).TargetHealthDescriptions?.map((item) => ({
          targetId: item.Target?.Id || null,
          port: item.Target?.Port || null,
          state: item.TargetHealth?.State || null,
          reason: item.TargetHealth?.Reason || null,
          description: item.TargetHealth?.Description || null,
        })) || []
      : [];

    const logGroupName = typeof deployment?.metadata?.cloudWatchLogGroupName === "string"
      ? deployment.metadata.cloudWatchLogGroupName
      : null;
    let logStreamName: string | null = null;
    let logLines: string[] = [];
    if (logGroupName) {
      const streams = (await this.logsClient().send(new DescribeLogStreamsCommand({
        logGroupName,
        orderBy: "LastEventTime",
        descending: true,
        limit: 5,
      }))).logStreams || [];
      const taskId = latestTask?.taskArn?.split("/").at(-1) || null;
      logStreamName = taskId
        ? streams.find((stream) => stream.logStreamName?.endsWith(`/${taskId}`))?.logStreamName || null
        : null;
      if (!logStreamName && deploymentStartedAt) {
        logStreamName = streams.find((stream) => (stream.lastEventTimestamp || 0) >= deploymentStartedAt)?.logStreamName || null;
      }
      if (logStreamName) {
        const events = (await this.logsClient().send(new GetLogEventsCommand({
          logGroupName,
          logStreamName,
          limit: 50,
          startFromHead: false,
        }))).events || [];
        logLines = events.slice(-25).map((item) => this.sanitize(item.message || ""));
      }
    }

    const targetPort = Number(targetHealth[0]?.port || 0) || null;
    const containerPort = deployment?.appPort || null;
    const summary = this.actionableFailureSummary({
      stoppedTaskReason: latestTask?.stoppedReason || null,
      containerExitCode: container?.exitCode ?? null,
      containerReason: container?.reason || null,
      containerPort,
      targetPort,
      logLines,
      targetHealth,
      healthCheckPath: deployment?.healthCheckPath || null,
    });

    const diagnosticCode = this.diagnosticCode(summary);
    const databaseLocalhost = diagnosticCode === "DATABASE_LOCALHOST_UNREACHABLE";
    return {
      diagnosticCode,
      rootCause: databaseLocalhost ? "app_connected_to_localhost_database" : diagnosticCode.toLowerCase(),
      platformFix: databaseLocalhost ? "provision_database_tier_or_inject_cloudmap_db_host" : "review_ecs_diagnostics",
      userMessage: databaseLocalhost ? "Your app tried to connect to a local database inside the app container. DeployGuard should connect it to the project database service instead." : summary,
      summary,
      stoppedTaskReason: this.sanitize(latestTask?.stoppedReason || "") || null,
      containerExitCode: container?.exitCode ?? null,
      containerReason: this.sanitize(container?.reason || "") || null,
      lastStoppedTaskArn: latestTask?.taskArn || null,
      taskEvents,
      targetHealth,
      logGroupName,
      logStreamName,
      logLines,
      containerPort,
      targetPort,
      healthCheckPath: deployment?.healthCheckPath || null,
    };
  }

  private actionableFailureSummary(input: {
    stoppedTaskReason: string | null;
    containerExitCode: number | null;
    containerReason: string | null;
    containerPort: number | null;
    targetPort: number | null;
    logLines: string[];
    targetHealth: Record<string, unknown>[];
    healthCheckPath: string | null;
  }) {
    const combined = `${input.stoppedTaskReason || ""} ${input.containerReason || ""} ${input.logLines.join(" ")}`;
    if (/(?:ECONNREFUSED|connection refused)[^\n]{0,100}(?:127\.0\.0\.1|localhost|::1)(?::(?:5432|3306|27017))?|connect[^\n]{0,100}(?:127\.0\.0\.1|localhost):(?:5432|3306|27017)/i.test(combined)) {
      return "Application is configured to reach its database at localhost. Inside ECS, localhost is the application container itself. Use the DeployGuard-managed database binding.";
    }
    const listeningPort = combined.match(/\b(?:listening|running|server|bundler)[^\n]{0,120}\bport\s+(\d{2,5})/i)?.[1];
    if (listeningPort && input.containerPort && Number(listeningPort) !== input.containerPort) {
      return `App is listening on port ${listeningPort}, but ECS and ALB use port ${input.containerPort}.`;
    }
    if (/CannotPullContainerError|pull image manifest|no basic auth credentials/i.test(combined)) {
      return "ECS could not pull the container image from ECR.";
    }
    if (/ERR_OSSL_EVP_UNSUPPORTED|digital envelope routines::unsupported/i.test(combined)) {
      return `Container exited with code ${input.containerExitCode ?? "unknown"}: the application runtime is incompatible with the selected Node/OpenSSL version.`;
    }
    if (/missing|required environment variable|is not defined/i.test(combined)) {
      return `Container exited with code ${input.containerExitCode ?? "unknown"}: a required environment variable appears to be missing.`;
    }
    if (input.containerExitCode !== null && input.containerExitCode !== 0) {
      const lastLog = [...input.logLines].reverse().find((line) => line.trim());
      return lastLog
        ? `Essential container exited with code ${input.containerExitCode}. Last sanitized log: ${lastLog.slice(0, 240)}`
        : `Essential container exited with code ${input.containerExitCode}. No application log line was available in CloudWatch.`;
    }
    if (input.targetHealth.some((item) => item.state === "unhealthy")) {
      return `Target failed ALB health checks on port ${input.targetPort || input.containerPort || "unknown"} at path ${input.healthCheckPath || "/"}.`;
    }
    return this.sanitize(input.stoppedTaskReason || input.containerReason || "ECS tasks failed to become healthy.");
  }

  private diagnosticCode(summary: string) {
    if (/database at localhost|localhost is the application container/i.test(summary)) return "DATABASE_LOCALHOST_UNREACHABLE";
    if (/listening on port/i.test(summary)) return "PORT_MISMATCH";
    if (/pull the container image/i.test(summary)) return "IMAGE_PULL_FAILED";
    if (/Node\/OpenSSL/i.test(summary)) return "RUNTIME_INCOMPATIBLE";
    if (/environment variable/i.test(summary)) return "MISSING_ENVIRONMENT_VARIABLE";
    if (/health checks/i.test(summary)) return "ALB_HEALTH_CHECK_FAILED";
    if (/exited with code/i.test(summary)) return "CONTAINER_EXITED";
    return "ECS_TASK_START_FAILED";
  }

  private parseEcrImage(imageUri: string | null) {
    if (!imageUri) return null;
    const match = imageUri.match(/^[^/]+\/(.+?)(?::([^:@/]+)|@(sha256:[a-f0-9]+))$/i);
    if (!match) return null;
    return { repositoryName: match[1], tag: match[2] || null, digest: match[3] || null };
  }

  private validFargateResources(cpu?: string, memory?: string) {
    const allowed: Record<string, number[]> = {
      "256": [512, 1024, 2048],
      "512": [1024, 2048, 3072, 4096],
      "1024": [2048, 3072, 4096, 5120, 6144, 7168, 8192],
      "2048": [4096, 5120, 6144, 7168, 8192, 9216, 10240, 11264, 12288, 13312, 14336, 15360, 16384],
      "4096": Array.from({ length: 23 }, (_, index) => 8192 + index * 1024),
    };
    return Boolean(cpu && memory && allowed[cpu]?.includes(Number(memory)));
  }

  private sanitize(value: string) {
    return value
      .replace(/AIza[0-9A-Za-z_-]{20,}/g, "[REDACTED_GOOGLE_AI_KEY]")
      .replace(/AKIA[0-9A-Z]{16}/g, "[REDACTED_AWS_ACCESS_KEY]")
      .replace(/gh[pousr]_[A-Za-z0-9_]{20,}/g, "[REDACTED_GITHUB_TOKEN]")
      .replace(/Bearer\s+[A-Za-z0-9._~+/=-]{12,}/gi, "Bearer [REDACTED]")
      .replace(/(password|token|secret|authorization|api[_-]?key)\s*[:=]\s*[^\s]+/gi, "$1=[REDACTED]")
      .slice(0, 1500);
  }

  private async event(
    projectId: string,
    pipelineRunId: string | null,
    deploymentId: string | null,
    eventType: string,
    status: string,
    message: string,
    metadata: Record<string, unknown> = {}
  ) {
    await this.eventRepository.save(
      this.eventRepository.create({
        projectId,
        pipelineRunId,
        deploymentId,
        eventType,
        status,
        message,
        source: "aws_ecs",
        metadata: this.safeMetadata({ projectId, deploymentId, eventType, status, ...metadata }),
      })
    );
  }

  private async audit(action: string, projectId: string, status: string, metadata: Record<string, unknown>) {
    await this.auditLogService.record({
      actorUser: null,
      action,
      resourceType: "orchestration",
      resourceId: projectId,
      status,
      metadata: this.safeMetadata({ projectId, ...metadata }),
    });
  }

  private safeMetadata(metadata: Record<string, unknown>) {
    const allowed = [
      "projectId",
      "deploymentId",
      "eventType",
      "status",
      "stable",
      "reason",
      "serviceArn",
      "desiredCount",
      "runningCount",
      "pendingCount",
      "rolloutState",
      "deployments",
      "diagnostics",
      "checkedAt",
    ];

    return Object.entries(metadata).reduce(
      (safe, [key, value]) => {
        if (allowed.includes(key) && value !== undefined) {
          safe[key] = value;
        }
        return safe;
      },
      {} as Record<string, unknown>
    );
  }

  private sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private failureReason(error: unknown, fallback: string) {
    if (!error || typeof error !== "object") {
      return fallback;
    }

    const awsError = error as { name?: string };
    return awsError.name ? `${fallback} ${awsError.name}` : fallback;
  }
}
