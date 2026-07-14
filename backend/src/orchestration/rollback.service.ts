import { BadRequestException, Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { In, Not, Repository } from "typeorm";
import { AuditLogService } from "../audit-log/audit-log.service";
import { AlbService } from "./alb.service";
import { EcsService } from "./ecs.service";
import { ProjectDeployment, ProjectDeploymentStatus } from "./project-deployment.entity";
import { ProjectOrchestrationEvent } from "./project-orchestration-event.entity";
import { ProjectRollbackRecord, RollbackStatus } from "./project-rollback-record.entity";
import { ProjectStableRelease, StableReleaseStatus } from "./project-stable-release.entity";

@Injectable()
export class RollbackService {
  constructor(
    @InjectRepository(ProjectDeployment)
    private readonly deploymentRepository: Repository<ProjectDeployment>,
    @InjectRepository(ProjectStableRelease)
    private readonly releaseRepository: Repository<ProjectStableRelease>,
    @InjectRepository(ProjectRollbackRecord)
    private readonly rollbackRepository: Repository<ProjectRollbackRecord>,
    @InjectRepository(ProjectOrchestrationEvent)
    private readonly eventRepository: Repository<ProjectOrchestrationEvent>,
    private readonly ecsService: EcsService,
    private readonly albService: AlbService,
    private readonly auditLogService: AuditLogService
  ) {}

  async saveStableRelease(projectId: string, pipelineRunId: string | null, commitSha: string, imageUri: string, taskDefinitionArn: string) {
    await this.releaseRepository.update(
      { projectId, environmentName: "dev", status: StableReleaseStatus.STABLE },
      { status: StableReleaseStatus.SUPERSEDED }
    );

    return this.releaseRepository.save(
      this.releaseRepository.create({
        projectId,
        environmentName: "dev",
        commitSha,
        shortCommitSha: commitSha.slice(0, 12),
        imageUri,
        taskDefinitionArn,
        deployedByPipelineRunId: pipelineRunId,
        deployedAt: new Date(),
        status: StableReleaseStatus.STABLE,
      })
    );
  }

  async getPreviousStableRelease(projectId: string, excludeCommitSha?: string | null) {
    return this.releaseRepository.findOne({
      where: {
        projectId,
        environmentName: "dev",
        status: In([StableReleaseStatus.STABLE, StableReleaseStatus.SUPERSEDED, StableReleaseStatus.ROLLBACK_TARGET]),
        ...(excludeCommitSha ? { commitSha: Not(excludeCommitSha) } : {}),
      },
      order: { deployedAt: "DESC" },
    });
  }

  async markDeploymentUnstable(projectId: string, pipelineRunId: string | null, reason: string) {
    const deployment = await this.deploymentRepository.findOne({
      where: { projectId, pipelineRunId: pipelineRunId || undefined },
      order: { createdAt: "DESC" },
    });

    if (deployment) {
      deployment.status = ProjectDeploymentStatus.UNHEALTHY;
      deployment.stable = false;
      deployment.errorMessage = reason;
      deployment.failedAt = new Date();
      await this.deploymentRepository.save(deployment);
    }

    return deployment;
  }

  async rollbackToPreviousStable(projectId: string, pipelineRunId?: string | null, reason = "Rollback requested.") {
    const deployment = await this.deploymentRepository.findOne({
      where: { projectId },
      order: { createdAt: "DESC" },
    });

    if (!deployment) {
      throw new BadRequestException("No deployment exists for rollback.");
    }

    const target = await this.getPreviousStableRelease(projectId, deployment.commitSha);

    if (!target) {
      deployment.status = ProjectDeploymentStatus.ROLLBACK_FAILED;
      deployment.rollbackStartedAt = new Date();
      deployment.rollbackCompletedAt = new Date();
      deployment.errorMessage = "No previous stable release available for rollback.";
      await this.deploymentRepository.save(deployment);
      throw new BadRequestException("No previous stable release available for rollback.");
    }

    deployment.status = ProjectDeploymentStatus.ROLLBACK_STARTED;
    deployment.rollbackStartedAt = new Date();
    deployment.previousTaskDefinitionArn = deployment.taskDefinitionArn;
    await this.deploymentRepository.save(deployment);

    const record = await this.rollbackRepository.save(
      this.rollbackRepository.create({
        projectId,
        deploymentId: deployment.id,
        pipelineRunId: pipelineRunId || deployment.pipelineRunId || null,
        fromCommitSha: deployment.commitSha,
        toCommitSha: target.commitSha,
        fromTaskDefinitionArn: deployment.taskDefinitionArn,
        toTaskDefinitionArn: target.taskDefinitionArn,
        reason,
        status: RollbackStatus.STARTED,
        startedAt: new Date(),
      })
    );

    await this.event(projectId, record.pipelineRunId || null, deployment.id, "rollback_service_update_started", "running", "Updating ECS service to previous stable task definition.", {
      rollbackId: record.id,
      toCommitSha: target.commitSha,
      toTaskDefinitionArn: target.taskDefinitionArn,
    });
    await this.audit("ROLLBACK_SERVICE_UPDATE_STARTED", projectId, "success", {
      deploymentId: deployment.id,
      rollbackId: record.id,
      toCommitSha: target.commitSha,
      toTaskDefinitionArn: target.taskDefinitionArn,
    });

    try {
      await this.ecsService.updateServiceToTaskDefinition(projectId, target.taskDefinitionArn);

      await this.event(projectId, record.pipelineRunId || null, deployment.id, "rollback_stability_wait_started", "running", "Waiting for rollback ECS service stability.", {
        rollbackId: record.id,
      });
      const stabilityResult = await this.ecsService.waitForServiceStability(projectId, deployment.ecsServiceArn);

      if (!stabilityResult.stable) {
        throw new BadRequestException(stabilityResult.reason || "Rollback ECS service did not become stable.");
      }

      await this.event(projectId, record.pipelineRunId || null, deployment.id, "rollback_health_check_started", "running", "Waiting for rollback ALB target health.", {
        rollbackId: record.id,
      });
      const albHealthResult = await this.albService.waitForHealthyTargets(projectId);

      if (!albHealthResult.healthy) {
        throw new BadRequestException(albHealthResult.reason || "Rollback ALB targets did not become healthy.");
      }

      deployment.status = ProjectDeploymentStatus.ROLLBACK_SUCCEEDED;
      deployment.commitSha = target.commitSha;
      deployment.shortCommitSha = target.shortCommitSha;
      deployment.imageUri = target.imageUri;
      deployment.taskDefinitionArn = target.taskDefinitionArn;
      deployment.rollbackCompletedAt = new Date();
      deployment.stable = true;
      deployment.errorMessage = null;
      deployment.metadata = this.safeMetadata({
        ...deployment.metadata,
        rollbackId: record.id,
        ecsStability: stabilityResult,
        albHealth: albHealthResult,
      });
      await this.deploymentRepository.save(deployment);

      record.status = RollbackStatus.SUCCEEDED;
      record.completedAt = new Date();
      record.metadata = this.safeMetadata({ ecsStability: stabilityResult, albHealth: albHealthResult });
      await this.rollbackRepository.save(record);

      await this.releaseRepository.update(
        { projectId, environmentName: "dev", status: StableReleaseStatus.STABLE },
        { status: StableReleaseStatus.SUPERSEDED }
      );
      target.status = StableReleaseStatus.STABLE;
      await this.releaseRepository.save(target);

      await this.event(projectId, record.pipelineRunId || null, deployment.id, "rollback_service_stable", "success", "Rollback ECS service is stable and ALB targets are healthy.", {
        rollbackId: record.id,
        toCommitSha: target.commitSha,
      });
      await this.audit("ROLLBACK_SERVICE_STABLE", projectId, "success", {
        deploymentId: deployment.id,
        rollbackId: record.id,
        toCommitSha: target.commitSha,
      });

      return { deployment, release: target, rollback: record };
    } catch (error) {
      const message = this.failureMessage(error, "Rollback failed.");
      deployment.status = ProjectDeploymentStatus.ROLLBACK_FAILED;
      deployment.rollbackCompletedAt = new Date();
      deployment.stable = false;
      deployment.errorMessage = message;
      await this.deploymentRepository.save(deployment);

      record.status = RollbackStatus.FAILED;
      record.completedAt = new Date();
      record.errorMessage = message;
      await this.rollbackRepository.save(record);

      await this.event(projectId, record.pipelineRunId || null, deployment.id, "rollback_service_failed", "failed", message, {
        rollbackId: record.id,
      });
      await this.audit("ROLLBACK_SERVICE_FAILED", projectId, "failed", {
        deploymentId: deployment.id,
        rollbackId: record.id,
        reason: message,
      });
      throw error;
    }
  }

  async waitForRollbackStability(projectId: string, _rollbackTaskDefinitionArn: string) {
    return this.ecsService.waitForServiceStability(projectId);
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
      "rollbackId",
      "toCommitSha",
      "toTaskDefinitionArn",
      "reason",
      "ecsStability",
      "albHealth",
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

    const badRequest = error as { response?: { message?: string }; name?: string };
    if (badRequest.name === "BadRequestException" && badRequest.response?.message) {
      return badRequest.response.message;
    }

    return badRequest.name ? `${fallback} ${badRequest.name}` : fallback;
  }
}
