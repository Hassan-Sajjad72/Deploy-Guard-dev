import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectRepository } from "@nestjs/typeorm";
import {
  DescribeServicesCommand,
  ECSClient,
  UpdateServiceCommand,
} from "@aws-sdk/client-ecs";
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
  checkedAt: string;
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

  async registerTaskDefinition(projectId: string, imageUri: string, deploymentProfile: Record<string, unknown>) {
    return { projectId, imageUri, deploymentProfile, status: "terraform_managed" };
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
