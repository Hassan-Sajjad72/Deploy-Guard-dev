import { BadRequestException, Injectable, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectRepository } from "@nestjs/typeorm";
import { MoreThan, Repository } from "typeorm";
import { AuditLogService } from "../audit-log/audit-log.service";
import { EcsService } from "./ecs.service";
import { ProjectDeployment, ProjectDeploymentStatus } from "./project-deployment.entity";
import { ProjectOrchestrationEvent } from "./project-orchestration-event.entity";
import { ProjectSpotInterruptionEvent, SpotInterruptionStatus } from "./project-spot-interruption-event.entity";
import { getOrchestrationConfig } from "./orchestration.config";

@Injectable()
export class SpotInterruptionService {
  constructor(
    @InjectRepository(ProjectDeployment)
    private readonly deploymentRepository: Repository<ProjectDeployment>,
    @InjectRepository(ProjectOrchestrationEvent)
    private readonly eventRepository: Repository<ProjectOrchestrationEvent>,
    @InjectRepository(ProjectSpotInterruptionEvent)
    private readonly spotRepository: Repository<ProjectSpotInterruptionEvent>,
    private readonly config: ConfigService,
    private readonly auditLogService: AuditLogService,
    private readonly ecsService: EcsService
  ) {}

  async configureEventBridgeRule(projectId: string) {
    return { projectId, status: "terraform_managed" };
  }

  async handleSpotInterruptionEvent(projectId: string, event: Record<string, unknown>, secret?: string | null) {
    const config = getOrchestrationConfig(this.config);

    if (!config.spotEventWebhookSecret) {
      throw new BadRequestException("Spot event webhook secret is not configured.");
    }

    if (secret !== config.spotEventWebhookSecret) {
      throw new UnauthorizedException("Invalid spot event webhook secret.");
    }

    const detail = (event.detail || {}) as Record<string, unknown>;
    const taskArn = String(detail.taskArn || detail.task || "");
    const reason = String(detail.stoppedReason || detail.stopCode || "ECS task interruption or service event received.");
    const deployment = await this.deploymentRepository.findOne({
      where: { projectId },
      order: { createdAt: "DESC" },
    });

    const saved = await this.recordSpotInterruption(projectId, taskArn || null, reason, {
      eventId: String(event.id || ""),
      eventTime: event.time ? new Date(String(event.time)) : null,
      deployment,
      detailType: String(event["detail-type"] || ""),
    });

    const recentHandled = await this.findRecentHandledEvent(projectId, config.spotRecoveryCooldownSeconds);

    try {
      if (recentHandled) {
        saved.status = SpotInterruptionStatus.HANDLED;
        saved.metadata = this.safeMetadata({
          ...saved.metadata,
          cooldownSkipped: true,
          recentSpotEventId: recentHandled.id,
        });
        await this.spotRepository.save(saved);
        await this.eventRepository.save(
          this.eventRepository.create({
            projectId,
            pipelineRunId: deployment?.pipelineRunId || null,
            deploymentId: deployment?.id || null,
            eventType: "spot_interruption_recovery_skipped",
            status: "success",
            message: "Spot recovery skipped because a recent replacement request already ran.",
            metadata: this.safeMetadata({ deploymentId: deployment?.id, cooldownSkipped: true, recentSpotEventId: recentHandled.id }),
          })
        );
        await this.auditLogService.record({
          actorUser: null,
          action: "SPOT_INTERRUPTION_RECOVERY_SKIPPED",
          resourceType: "orchestration",
          resourceId: projectId,
          status: "success",
          metadata: this.safeMetadata({ projectId, deploymentId: deployment?.id, eventId: saved.eventId, cooldownSkipped: true }),
        });
        return saved;
      }

      await this.triggerReplacementTaskOrForceDeployment(projectId);
      saved.status = SpotInterruptionStatus.HANDLED;
      await this.spotRepository.save(saved);
      await this.eventRepository.save(
        this.eventRepository.create({
          projectId,
          pipelineRunId: deployment?.pipelineRunId || null,
          deploymentId: deployment?.id || null,
          eventType: "spot_interruption_handled",
          status: "success",
          message: "Spot interruption handled after ECS replacement deployment request.",
          metadata: this.safeMetadata({ deploymentId: deployment?.id, eventId: saved.eventId }),
        })
      );
      await this.auditLogService.record({
        actorUser: null,
        action: "SPOT_INTERRUPTION_HANDLED",
        resourceType: "orchestration",
        resourceId: projectId,
        status: "success",
        metadata: this.safeMetadata({ projectId, deploymentId: deployment?.id, eventId: saved.eventId }),
      });
    } catch (error) {
      const message = this.failureMessage(error, "Spot interruption recovery failed.");
      saved.status = SpotInterruptionStatus.FAILED;
      saved.metadata = this.safeMetadata({ ...saved.metadata, reason: message });
      await this.spotRepository.save(saved);
      await this.eventRepository.save(
        this.eventRepository.create({
          projectId,
          pipelineRunId: deployment?.pipelineRunId || null,
          deploymentId: deployment?.id || null,
          eventType: "spot_interruption_recovery_failed",
          status: "failed",
          message,
          metadata: this.safeMetadata({ deploymentId: deployment?.id, eventId: saved.eventId, reason: message }),
        })
      );
      await this.auditLogService.record({
        actorUser: null,
        action: "SPOT_INTERRUPTION_RECOVERY_FAILED",
        resourceType: "orchestration",
        resourceId: projectId,
        status: "failed",
        metadata: this.safeMetadata({ projectId, deploymentId: deployment?.id, eventId: saved.eventId, reason: message }),
      });
      throw error;
    }

    return saved;
  }

  async recordSpotInterruption(
    projectId: string,
    taskArn: string | null,
    reason: string,
    options: {
      eventId?: string | null;
      eventTime?: Date | null;
      deployment?: ProjectDeployment | null;
      detailType?: string | null;
    } = {}
  ) {
    const deployment = options.deployment || await this.deploymentRepository.findOne({
      where: { projectId },
      order: { createdAt: "DESC" },
    });
    const saved = await this.spotRepository.save(
      this.spotRepository.create({
        projectId,
        deploymentId: deployment?.id || null,
        pipelineRunId: deployment?.pipelineRunId || null,
        ecsClusterArn: deployment?.ecsClusterArn || null,
        ecsServiceArn: deployment?.ecsServiceArn || null,
        taskArn,
        eventId: options.eventId || null,
        eventTime: options.eventTime || null,
        reason,
        status: SpotInterruptionStatus.RECEIVED,
        metadata: this.safeMetadata({ detailType: options.detailType || null }),
      })
    );

    if (deployment) {
      deployment.status = ProjectDeploymentStatus.INTERRUPTED;
      await this.deploymentRepository.save(deployment);
    }

    await this.eventRepository.save(
      this.eventRepository.create({
        projectId,
        pipelineRunId: deployment?.pipelineRunId || null,
        deploymentId: deployment?.id || null,
        eventType: "spot_interruption_detected",
        status: "warning",
        message: reason,
        metadata: this.safeMetadata({
          taskArn,
          eventId: options.eventId,
          detailType: options.detailType,
        }),
      })
    );
    await this.auditLogService.record({
      actorUser: null,
      action: "SPOT_INTERRUPTION_DETECTED",
      resourceType: "orchestration",
      resourceId: projectId,
      status: "success",
      metadata: this.safeMetadata({ projectId, deploymentId: deployment?.id, taskArn, eventId: options.eventId }),
    });

    return saved;
  }

  async triggerReplacementTaskOrForceDeployment(projectId: string) {
    const deployment = await this.deploymentRepository.findOne({
      where: { projectId },
      order: { createdAt: "DESC" },
    });

    const result = await this.ecsService.forceNewDeployment(projectId);

    if (deployment) {
      deployment.status = ProjectDeploymentStatus.DEPLOYING;
      await this.deploymentRepository.save(deployment);
    }

    await this.eventRepository.save(
      this.eventRepository.create({
        projectId,
        pipelineRunId: deployment?.pipelineRunId || null,
        deploymentId: deployment?.id || null,
        eventType: "replacement_task_triggered",
        status: "success",
        message: "Replacement task or ECS force deployment requested.",
        metadata: this.safeMetadata({ deploymentId: deployment?.id, serviceArn: result.serviceArn }),
      })
    );
    await this.auditLogService.record({
      actorUser: null,
      action: "REPLACEMENT_TASK_TRIGGERED",
      resourceType: "orchestration",
      resourceId: projectId,
      status: "success",
      metadata: this.safeMetadata({ projectId, deploymentId: deployment?.id, serviceArn: result.serviceArn }),
    });

    return { projectId, deploymentId: deployment?.id || null, status: "replacement_triggered" };
  }

  async list(projectId: string) {
    return this.spotRepository.find({
      where: { projectId },
      order: { createdAt: "DESC" },
      take: 50,
    });
  }

  private safeMetadata(metadata: Record<string, unknown>) {
    const allowed = [
      "projectId",
      "deploymentId",
      "taskArn",
      "eventId",
      "detailType",
      "serviceArn",
      "reason",
      "cooldownSkipped",
      "recentSpotEventId",
    ];
    return Object.entries(metadata).reduce((safe, [key, value]) => {
      if (allowed.includes(key) && value !== undefined) safe[key] = value;
      return safe;
    }, {} as Record<string, unknown>);
  }

  private findRecentHandledEvent(projectId: string, cooldownSeconds: number) {
    if (cooldownSeconds <= 0) {
      return null;
    }

    return this.spotRepository.findOne({
      where: {
        projectId,
        status: SpotInterruptionStatus.HANDLED,
        createdAt: MoreThan(new Date(Date.now() - cooldownSeconds * 1000)),
      },
      order: { createdAt: "DESC" },
    });
  }

  private failureMessage(error: unknown, fallback: string) {
    if (!error || typeof error !== "object") {
      return fallback;
    }

    const awsError = error as { name?: string };
    return awsError.name ? `${fallback} ${awsError.name}` : fallback;
  }
}
