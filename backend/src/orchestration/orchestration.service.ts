import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectRepository } from "@nestjs/typeorm";
import { Request } from "express";
import { Repository } from "typeorm";
import { AuditLogService } from "../audit-log/audit-log.service";
import { InfrastructureService } from "../infrastructure/infrastructure.service";
import { NotificationDispatcherService } from "../notifications/notification-dispatcher.service";
import { ProjectInfrastructureEnvironment } from "../infrastructure/project-infrastructure-environment.entity";
import { ProjectPipelineRun } from "../projects/project-pipeline-run.entity";
import { Project, ProjectStatus, ProjectVisibility } from "../projects/project.entity";
import { User, UserRole } from "../users/user.entity";
import { AlbService } from "./alb.service";
import { AutoscalingService } from "./autoscaling.service";
import { EcsService } from "./ecs.service";
import { ProjectDeployment, ProjectDeploymentStatus } from "./project-deployment.entity";
import { ProjectOrchestrationEvent } from "./project-orchestration-event.entity";
import { ProjectStableRelease } from "./project-stable-release.entity";
import { SpotInterruptionService } from "./spot-interruption.service";
import { getOrchestrationConfig } from "./orchestration.config";

type RequestInfo = Request | undefined;

@Injectable()
export class OrchestrationService {
  constructor(
    @InjectRepository(Project)
    private readonly projectRepository: Repository<Project>,
    @InjectRepository(ProjectPipelineRun)
    private readonly runRepository: Repository<ProjectPipelineRun>,
    @InjectRepository(ProjectInfrastructureEnvironment)
    private readonly environmentRepository: Repository<ProjectInfrastructureEnvironment>,
    @InjectRepository(ProjectDeployment)
    private readonly deploymentRepository: Repository<ProjectDeployment>,
    @InjectRepository(ProjectStableRelease)
    private readonly releaseRepository: Repository<ProjectStableRelease>,
    @InjectRepository(ProjectOrchestrationEvent)
    private readonly eventRepository: Repository<ProjectOrchestrationEvent>,
    private readonly infrastructureService: InfrastructureService,
    private readonly config: ConfigService,
    private readonly auditLogService: AuditLogService,
    private readonly ecsService: EcsService,
    private readonly albService: AlbService,
    private readonly autoscalingService: AutoscalingService,
    private readonly spotInterruptionService: SpotInterruptionService,
    private readonly notifications: NotificationDispatcherService
  ) {}

  async deploy(user: User, projectId: string, req?: RequestInfo) {
    return this.infrastructureService.deploy(user, projectId, req);
  }

  async getStatus(user: User, projectId: string) {
    const project = await this.findProjectForView(user, projectId);
    const deployment = await this.deploymentRepository.findOne({
      where: { projectId: project.id },
      order: { createdAt: "DESC" },
    });
    let deploymentView = deployment;
    if (
      deployment &&
      [ProjectDeploymentStatus.FAILED, ProjectDeploymentStatus.UNHEALTHY, ProjectDeploymentStatus.ROLLBACK_FAILED]
        .includes(deployment.status as ProjectDeploymentStatus) &&
      !(deployment.metadata?.ecsStability as Record<string, unknown> | undefined)?.diagnostics
    ) {
      const diagnostics = await this.ecsService.getFailureDiagnostics(project.id).catch(() => null);
      if (diagnostics) {
        deploymentView = {
          ...deployment,
          errorMessage: diagnostics.summary,
          metadata: {
            ...(deployment.metadata || {}),
            ecsStability: {
              ...((deployment.metadata?.ecsStability as Record<string, unknown> | undefined) || {}),
              reason: diagnostics.summary,
              diagnostics,
            },
          },
        } as ProjectDeployment;
      }
    }
    const stableRelease = await this.releaseRepository.findOne({
      where: { projectId: project.id, status: "stable" },
      order: { deployedAt: "DESC" },
    });
    const spotEvents = await this.spotInterruptionService.list(project.id);

    return {
      canManage: user.role !== UserRole.READONLY && (user.role === UserRole.ADMIN || project.ownerUserId === user.id),
      deployment: deploymentView,
      stableRelease,
      spotEvents,
      service: await this.ecsService.getServiceStatus(project.id),
      targetHealth: await this.albService.getTargetHealth(project.id),
      scaling: await this.autoscalingService.getScalingStatus(project.id),
    };
  }

  async getEvents(user: User, projectId: string) {
    const project = await this.findProjectForView(user, projectId);
    return this.eventRepository.find({
      where: { projectId: project.id },
      order: { occurredAt: "ASC", sequenceNumber: "ASC" },
    });
  }

  async getReleases(user: User, projectId: string) {
    const project = await this.findProjectForView(user, projectId);
    return this.releaseRepository.find({
      where: { projectId: project.id },
      order: { deployedAt: "DESC" },
      take: 50,
    });
  }

  async getTargetHealth(user: User, projectId: string) {
    const project = await this.findProjectForView(user, projectId);
    return this.albService.getTargetHealth(project.id);
  }

  async getScaling(user: User, projectId: string) {
    const project = await this.findProjectForView(user, projectId);
    return this.autoscalingService.getScalingStatus(project.id);
  }

  async updateScaling(user: User, projectId: string, dto: { minTasks?: number; maxTasks?: number; cpuTargetPercent?: number }, req?: RequestInfo) {
    const project = await this.findProjectForManage(user, projectId);
    const result = await this.autoscalingService.updateScalingPolicy(
      project.id,
      Number(dto.minTasks || 1),
      Number(dto.maxTasks || 3),
      Number(dto.cpuTargetPercent || 60)
    );
    await this.event(project.id, null, null, "autoscaling_policy_configured", "success", "Auto-scaling policy updated.", user, result);
    await this.audit("SCALING_POLICY_UPDATED", project.id, user, "success", result, req);
    return result;
  }

  async handleSpotEvent(projectId: string, event: Record<string, unknown>, secret?: string | null) {
    return this.spotInterruptionService.handleSpotInterruptionEvent(projectId, event, secret);
  }

  async recordDeploymentFromInfrastructure(projectId: string, pipelineRunId: string, actorUser?: User | null) {
    const run = await this.runRepository.findOne({ where: { id: pipelineRunId, projectId } });

    if (!run || !run.ecrImageUri || !run.commitSha) {
      throw new BadRequestException("ECS deployment requires an ECR image URI and full commit SHA.");
    }

    const environment = await this.environmentRepository.findOne({
      where: { projectId },
      order: { createdAt: "DESC" },
    });
    const outputs = environment?.terraformOutputs || {};
    const taskDefinitionArn = this.stringOutput(outputs.ecs_task_definition_arn);

    if (!taskDefinitionArn) {
      throw new BadRequestException("ECS task definition output is missing. Terraform ECS service was not created.");
    }

    const previous = await this.deploymentRepository.findOne({
      where: { projectId, stable: true },
      order: { deploymentCompletedAt: "DESC" },
    });
    let deployment = await this.deploymentRepository.findOne({
      where: { projectId, pipelineRunId },
      order: { createdAt: "DESC" },
    });

    deployment = deployment || this.deploymentRepository.create({ projectId, pipelineRunId });
    deployment.infrastructureEnvironmentId = environment?.id || null;
    deployment.status = ProjectDeploymentStatus.WAITING_FOR_SERVICE_STABILITY;
    deployment.environmentName = "dev";
    deployment.commitSha = run.commitSha;
    deployment.shortCommitSha = run.commitSha.slice(0, 12);
    deployment.imageUri = run.ecrImageUri;
    deployment.taskDefinitionArn = taskDefinitionArn;
    deployment.previousTaskDefinitionArn = previous?.taskDefinitionArn || null;
    deployment.ecsClusterArn = this.stringOutput(outputs.ecs_cluster_arn);
    deployment.ecsClusterName = this.stringOutput(outputs.ecs_cluster_name);
    deployment.ecsServiceArn = this.stringOutput(outputs.ecs_service_arn);
    deployment.ecsServiceName = this.stringOutput(outputs.ecs_service_name);
    deployment.albArn = this.stringOutput(outputs.alb_arn);
    deployment.albDnsName = this.stringOutput(outputs.alb_dns_name);
    deployment.targetGroupArn = this.stringOutput(outputs.alb_target_group_arn);
    deployment.listenerArn = this.stringOutput(outputs.alb_listener_arn);
    deployment.healthCheckPath = this.stringOutput(outputs.alb_health_check_path) || "/health";
    deployment.appPort = Number(outputs.ecs_container_port || 3000);
    deployment.desiredCount = Number(outputs.ecs_desired_count || 1);
    deployment.minTasks = Number(outputs.ecs_min_tasks || 1);
    deployment.maxTasks = Number(outputs.ecs_max_tasks || 3);
    deployment.cpuTargetPercent = Number(outputs.ecs_cpu_target_percent || 60);
    deployment.capacityProviderStrategy = Array.isArray(outputs.ecs_capacity_provider_strategy)
      ? outputs.ecs_capacity_provider_strategy as Record<string, unknown>[]
      : [];
    deployment.efsMountConfig = outputs.efs_enabled ? { enabled: true, fileSystemId: outputs.efs_file_system_id, accessPointId: outputs.efs_access_point_id } : null;
    deployment.cloudMapNamespaceId = this.stringOutput(outputs.cloud_map_namespace_id);
    deployment.cloudMapServiceName = "app";
    deployment.deploymentStartedAt = deployment.deploymentStartedAt || new Date();
    deployment.metadata = this.safeMetadata({
      spotEventRuleName: outputs.spot_event_rule_name,
      spotEventRuleArn: outputs.spot_event_rule_arn,
      cloudWatchLogGroupName: outputs.ecs_log_group_name,
    });

    deployment = await this.deploymentRepository.save(deployment);
    const configurationValidation = await this.ecsService.validateDeploymentConfiguration(deployment);
    deployment.metadata = this.safeMetadata({
      ...deployment.metadata,
      preDeploymentValidation: configurationValidation,
    });
    await this.deploymentRepository.save(deployment);
    await this.event(
      projectId,
      pipelineRunId,
      deployment.id,
      "ecs_predeployment_validation",
      configurationValidation.passed ? "success" : "failed",
      configurationValidation.passed
        ? "ECR image, task definition, container port, target group, health path, and Fargate resources are consistent."
        : configurationValidation.checks.find((check) => !check.passed)?.message || "ECS deployment configuration validation failed.",
      actorUser || null,
      { preDeploymentValidation: configurationValidation }
    );
    if (!configurationValidation.passed) {
      const reason = configurationValidation.checks.find((check) => !check.passed)?.message || "ECS deployment configuration validation failed.";
      deployment.status = ProjectDeploymentStatus.UNHEALTHY;
      deployment.stable = false;
      deployment.errorMessage = reason;
      deployment.failedAt = new Date();
      await this.deploymentRepository.save(deployment);
      throw new BadRequestException(reason);
    }
    await this.event(projectId, pipelineRunId, deployment.id, "ecs_service_stability_wait_started", "running", "Waiting for ECS service stability.", actorUser || null);
    await this.audit("ECS_SERVICE_STABILITY_WAIT_STARTED", projectId, actorUser || null, "success", { deploymentId: deployment.id });
    const stabilityResult = await this.ecsService.waitForServiceStability(projectId, deployment.ecsServiceArn);

    deployment.metadata = this.safeMetadata({
      ...deployment.metadata,
      spotEventRuleName: outputs.spot_event_rule_name,
      spotEventRuleArn: outputs.spot_event_rule_arn,
      cloudWatchLogGroupName: outputs.ecs_log_group_name,
      ecsStability: stabilityResult,
    });

    if (!stabilityResult.stable) {
      deployment.status = ProjectDeploymentStatus.UNHEALTHY;
      deployment.stable = false;
      deployment.errorMessage = stabilityResult.reason || "ECS service did not become stable.";
      deployment.failedAt = new Date();
      await this.deploymentRepository.save(deployment);
      await this.event(projectId, pipelineRunId, deployment.id, "ecs_service_unhealthy", "failed", deployment.errorMessage, actorUser || null, stabilityResult);
      await this.audit("ECS_SERVICE_UNSTABLE", projectId, actorUser || null, "failed", { deploymentId: deployment.id, reason: deployment.errorMessage });
      if (previous?.taskDefinitionArn) {
        await this.attemptAutoRollback(projectId, pipelineRunId, deployment, deployment.errorMessage, actorUser || null);
      } else {
        await this.event(projectId, pipelineRunId, deployment.id, "rollback_unavailable", "warning", "No previous stable release is available; the ECS failure remains the primary recovery reason.", actorUser || null);
      }
      throw new BadRequestException(deployment.errorMessage);
    }

    await this.event(projectId, pipelineRunId, deployment.id, "alb_health_check_wait_started", "running", "Waiting for ALB target health.", actorUser || null);
    await this.audit("ALB_HEALTH_CHECK_WAIT_STARTED", projectId, actorUser || null, "success", { deploymentId: deployment.id });
    const albHealthResult = await this.albService.waitForHealthyTargets(projectId);

    deployment.metadata = this.safeMetadata({
      ...deployment.metadata,
      albHealth: albHealthResult,
    });

    if (!albHealthResult.healthy) {
      deployment.status = ProjectDeploymentStatus.UNHEALTHY;
      deployment.stable = false;
      deployment.errorMessage = albHealthResult.reason || "ALB targets did not become healthy.";
      deployment.failedAt = new Date();
      await this.deploymentRepository.save(deployment);
      await this.event(projectId, pipelineRunId, deployment.id, "alb_targets_unhealthy", "failed", deployment.errorMessage, actorUser || null, albHealthResult);
      await this.audit("ALB_TARGETS_UNHEALTHY", projectId, actorUser || null, "failed", { deploymentId: deployment.id, reason: deployment.errorMessage });
      if (previous?.taskDefinitionArn) {
        await this.attemptAutoRollback(projectId, pipelineRunId, deployment, deployment.errorMessage, actorUser || null);
      } else {
        await this.event(projectId, pipelineRunId, deployment.id, "rollback_unavailable", "warning", "No previous stable release is available; the ALB failure remains the primary recovery reason.", actorUser || null);
      }
      throw new BadRequestException(deployment.errorMessage);
    }

    deployment.status = ProjectDeploymentStatus.HEALTHY;
    deployment.stable = true;
    deployment.deploymentCompletedAt = new Date();
    await this.deploymentRepository.save(deployment);
    const release = await this.rollbackService.saveStableRelease(projectId, pipelineRunId, run.commitSha, run.ecrImageUri, taskDefinitionArn);
    release.ecsServiceArn = deployment.ecsServiceArn;
    release.healthCheckPath = deployment.healthCheckPath;
    release.appPort = deployment.appPort;
    await this.releaseRepository.save(release);

    await this.event(projectId, pipelineRunId, deployment.id, "deployment_marked_stable", "success", "Deployment marked stable.", actorUser || null, {
      commitSha: run.commitSha,
      taskDefinitionArn,
    });
    await this.audit("DEPLOYMENT_MARKED_STABLE", projectId, actorUser || null, "success", {
      deploymentId: deployment.id,
      commitSha: run.commitSha,
      taskDefinitionArn,
    });
    await this.event(projectId, pipelineRunId, deployment.id, "deployment_completed", "success", "Deployment completed after ECS stability and ALB health checks.", actorUser || null, {
      commitSha: run.commitSha,
      taskDefinitionArn,
    });
    await this.audit("DEPLOYMENT_COMPLETED", projectId, actorUser || null, "success", {
      deploymentId: deployment.id,
      commitSha: run.commitSha,
      taskDefinitionArn,
    });

    return deployment;
  }

  private async attemptAutoRollback(
    projectId: string,
    pipelineRunId: string,
    deployment: ProjectDeployment,
    reason: string,
    actorUser: User | null
  ) {
    const config = getOrchestrationConfig(this.config);

    if (!config.enableAutoRollback) {
      return null;
    }

    await this.event(projectId, pipelineRunId, deployment.id, "rollback_started", "running", "Automatic rollback started.", actorUser, { reason });
    await this.audit("ROLLBACK_STARTED", projectId, actorUser, "success", { deploymentId: deployment.id, reason });

    try {
      const result = await this.rollbackService.rollbackToPreviousStable(projectId, pipelineRunId, reason);
      await this.event(projectId, pipelineRunId, deployment.id, "rollback_succeeded", "success", "Automatic rollback completed.", actorUser, {
        toCommitSha: result.release.commitSha,
      });
      await this.audit("ROLLBACK_SUCCEEDED", projectId, actorUser, "success", {
        deploymentId: deployment.id,
        toCommitSha: result.release.commitSha,
      });
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Automatic rollback failed.";
      await this.event(projectId, pipelineRunId, deployment.id, "rollback_failed", "failed", message, actorUser, { reason: message });
      await this.audit("ROLLBACK_FAILED", projectId, actorUser, "failed", { deploymentId: deployment.id, reason: message });
      return null;
    }
  }

  async event(
    projectId: string,
    pipelineRunId: string | null,
    deploymentId: string | null,
    eventType: string,
    status: string,
    message: string,
    actorUser?: User | null,
    metadata: Record<string, unknown> = {}
  ) {
    const event = await this.eventRepository.save(
      this.eventRepository.create({
        projectId,
        pipelineRunId,
        deploymentId,
        eventType,
        status,
        message,
        source: "pipeline_worker",
        actorUserId: actorUser?.id || null,
        metadata: this.safeMetadata({ projectId, pipelineRunId, deploymentId, eventType, status, ...metadata }),
      })
    );
    await this.notifications.dispatch({ projectId, pipelineRunId, eventId: event.id, stage: eventType, status, message }).catch(() => undefined);
    return event;
  }

  async audit(action: string, projectId: string, actorUser: User | null, status: string, metadata: Record<string, unknown>, req?: RequestInfo) {
    await this.auditLogService.record({
      actorUser,
      action,
      resourceType: "orchestration",
      resourceId: projectId,
      status,
      metadata: this.safeMetadata({ projectId, ...metadata }),
      req,
    });
  }

  async getLatestDeploymentEvidence(projectId: string, pipelineRunId: string) {
    const deployment = await this.deploymentRepository.findOne({
      where: { projectId, pipelineRunId },
      order: { createdAt: "DESC" },
    });
    const stability = deployment?.metadata?.ecsStability as Record<string, unknown> | undefined;
    return {
      deploymentId: deployment?.id || null,
      deploymentStatus: deployment?.status || null,
      diagnostics: stability?.diagnostics || null,
    };
  }

  private async findProjectForView(user: User, projectId: string) {
    const project = await this.projectRepository.findOne({ where: { id: projectId } });

    if (!project || project.status === ProjectStatus.ARCHIVED) {
      throw new NotFoundException("Project not found");
    }

    if (
      user.role === UserRole.ADMIN ||
      project.ownerUserId === user.id ||
      (user.role === UserRole.READONLY && project.visibility === ProjectVisibility.WORKSPACE)
    ) {
      return project;
    }

    throw new ForbiddenException("Insufficient permissions");
  }

  private async findProjectForManage(user: User, projectId: string) {
    const project = await this.findProjectForView(user, projectId);

    if (user.role === UserRole.READONLY) {
      throw new ForbiddenException("Insufficient permissions");
    }

    if (user.role === UserRole.ADMIN || project.ownerUserId === user.id) {
      return project;
    }

    throw new ForbiddenException("Insufficient permissions");
  }

  private safeMetadata(metadata: Record<string, unknown>) {
    const allowed = [
      "projectId",
      "pipelineRunId",
      "deploymentId",
      "eventType",
      "status",
      "commitSha",
      "taskDefinitionArn",
      "toCommitSha",
      "reason",
      "minTasks",
      "maxTasks",
      "cpuTargetPercent",
      "spotEventRuleName",
      "spotEventRuleArn",
      "cloudWatchLogGroupName",
      "ecsStability",
      "albHealth",
      "preDeploymentValidation",
    ];

    return Object.entries(metadata).reduce((safe, [key, value]) => {
      if (allowed.includes(key) && value !== undefined) safe[key] = value;
      return safe;
    }, {} as Record<string, unknown>);
  }

  private stringOutput(value: unknown) {
    return value === undefined || value === null ? null : String(value);
  }
}
