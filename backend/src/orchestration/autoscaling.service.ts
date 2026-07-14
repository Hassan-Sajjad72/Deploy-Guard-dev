import { BadRequestException, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectRepository } from "@nestjs/typeorm";
import {
  ApplicationAutoScalingClient,
  PutScalingPolicyCommand,
  RegisterScalableTargetCommand,
} from "@aws-sdk/client-application-auto-scaling";
import { ECSClient, UpdateServiceCommand } from "@aws-sdk/client-ecs";
import { Repository } from "typeorm";
import { AuditLogService } from "../audit-log/audit-log.service";
import { ProjectDeployment, ProjectDeploymentStatus } from "./project-deployment.entity";
import { ProjectOrchestrationEvent } from "./project-orchestration-event.entity";

@Injectable()
export class AutoscalingService {
  constructor(
    @InjectRepository(ProjectDeployment)
    private readonly deploymentRepository: Repository<ProjectDeployment>,
    @InjectRepository(ProjectOrchestrationEvent)
    private readonly eventRepository: Repository<ProjectOrchestrationEvent>,
    private readonly config: ConfigService,
    private readonly auditLogService: AuditLogService
  ) {}

  async configureTargetTrackingCpu(projectId: string, clusterName: string, serviceName: string) {
    return { projectId, clusterName, serviceName, status: "terraform_managed" };
  }

  async updateScalingPolicy(projectId: string, minTasks: number, maxTasks: number, cpuTargetPercent: number) {
    if (minTasks < 1 || maxTasks < minTasks || maxTasks > 20) {
      throw new BadRequestException("Scaling limits must be between 1 and 20 tasks, with max >= min.");
    }

    if (cpuTargetPercent < 10 || cpuTargetPercent > 90) {
      throw new BadRequestException("CPU target percent must be between 10 and 90.");
    }

    const deployment = await this.deploymentRepository.findOne({
      where: { projectId },
      order: { createdAt: "DESC" },
    });

    if (!deployment?.ecsClusterName || !deployment.ecsServiceName) {
      throw new BadRequestException("ECS cluster and service names are required before scaling can be updated.");
    }

    const resourceId = `service/${deployment.ecsClusterName}/${deployment.ecsServiceName}`;
    await this.event(projectId, deployment.pipelineRunId || null, deployment.id, "autoscaling_policy_update_started", "running", "Updating live ECS auto-scaling policy.", {
      minTasks,
      maxTasks,
      cpuTargetPercent,
    });
    await this.audit("SCALING_POLICY_UPDATE_STARTED", projectId, "success", {
      deploymentId: deployment.id,
      minTasks,
      maxTasks,
      cpuTargetPercent,
    });

    try {
      await this.autoscalingClient().send(
        new RegisterScalableTargetCommand({
          ServiceNamespace: "ecs",
          ScalableDimension: "ecs:service:DesiredCount",
          ResourceId: resourceId,
          MinCapacity: minTasks,
          MaxCapacity: maxTasks,
        })
      );

      await this.autoscalingClient().send(
        new PutScalingPolicyCommand({
          PolicyName: `deployguard-${projectId}-cpu-target-tracking`,
          PolicyType: "TargetTrackingScaling",
          ServiceNamespace: "ecs",
          ScalableDimension: "ecs:service:DesiredCount",
          ResourceId: resourceId,
          TargetTrackingScalingPolicyConfiguration: {
            TargetValue: cpuTargetPercent,
            PredefinedMetricSpecification: {
              PredefinedMetricType: "ECSServiceAverageCPUUtilization",
            },
            ScaleInCooldown: 60,
            ScaleOutCooldown: 60,
          },
        })
      );

      if ((deployment.desiredCount || 1) < minTasks) {
        await this.ecsClient().send(
          new UpdateServiceCommand({
            cluster: deployment.ecsClusterName,
            service: deployment.ecsServiceName,
            desiredCount: minTasks,
          })
        );
        deployment.desiredCount = minTasks;
      }

      deployment.minTasks = minTasks;
      deployment.maxTasks = maxTasks;
      deployment.cpuTargetPercent = cpuTargetPercent;
      deployment.status = ProjectDeploymentStatus.SCALED;
      await this.deploymentRepository.save(deployment);

      const result = { projectId, minTasks, maxTasks, cpuTargetPercent, status: "updated" };
      await this.event(projectId, deployment.pipelineRunId || null, deployment.id, "autoscaling_policy_configured", "success", "Live ECS auto-scaling policy updated.", result);
      await this.audit("SCALING_POLICY_UPDATED", projectId, "success", {
        deploymentId: deployment.id,
        minTasks,
        maxTasks,
        cpuTargetPercent,
      });
      return result;
    } catch (error) {
      const message = this.failureMessage(error, "Failed to update live ECS auto-scaling policy.");
      await this.event(projectId, deployment.pipelineRunId || null, deployment.id, "autoscaling_policy_update_failed", "failed", message, {
        minTasks,
        maxTasks,
        cpuTargetPercent,
      });
      await this.audit("SCALING_POLICY_UPDATE_FAILED", projectId, "failed", {
        deploymentId: deployment.id,
        minTasks,
        maxTasks,
        cpuTargetPercent,
        reason: message,
      });
      throw new BadRequestException(message);
    }
  }

  async getScalingStatus(projectId: string) {
    const deployment = await this.deploymentRepository.findOne({
      where: { projectId },
      order: { createdAt: "DESC" },
    });

    return {
      minTasks: deployment?.minTasks || 1,
      maxTasks: deployment?.maxTasks || 3,
      cpuTargetPercent: deployment?.cpuTargetPercent || 60,
      desiredCount: deployment?.desiredCount || 1,
      capacityProviderStrategy: deployment?.capacityProviderStrategy || [],
      status: deployment ? deployment.status : "not_configured",
    };
  }

  private autoscalingClient() {
    return new ApplicationAutoScalingClient({
      region: this.config.get<string>("AWS_REGION", "us-east-1"),
    });
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
      "minTasks",
      "maxTasks",
      "cpuTargetPercent",
      "reason",
    ];

    return Object.entries(metadata).reduce((safe, [key, value]) => {
      if (allowed.includes(key) && value !== undefined) safe[key] = value;
      return safe;
    }, {} as Record<string, unknown>);
  }

  private failureMessage(error: unknown, fallback: string) {
    if (!error || typeof error !== "object") {
      return fallback;
    }

    const awsError = error as { name?: string };
    return awsError.name ? `${fallback} ${awsError.name}` : fallback;
  }
}
