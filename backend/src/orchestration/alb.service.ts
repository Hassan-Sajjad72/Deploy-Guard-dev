import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectRepository } from "@nestjs/typeorm";
import {
  DescribeTargetHealthCommand,
  ElasticLoadBalancingV2Client,
} from "@aws-sdk/client-elastic-load-balancing-v2";
import { Repository } from "typeorm";
import { AuditLogService } from "../audit-log/audit-log.service";
import { ProjectDeployment } from "./project-deployment.entity";
import { ProjectOrchestrationEvent } from "./project-orchestration-event.entity";
import { getOrchestrationConfig } from "./orchestration.config";

type AlbHealthResult = {
  healthy: boolean;
  reason?: string;
  targetGroupArn: string | null;
  healthyCount: number;
  unhealthyCount: number;
  targetStates: Record<string, unknown>[];
  checkedAt: string;
};

@Injectable()
export class AlbService {
  constructor(
    @InjectRepository(ProjectDeployment)
    private readonly deploymentRepository: Repository<ProjectDeployment>,
    @InjectRepository(ProjectOrchestrationEvent)
    private readonly eventRepository: Repository<ProjectOrchestrationEvent>,
    private readonly config: ConfigService,
    private readonly auditLogService: AuditLogService
  ) {}

  async createOrUpdateAlb(projectId: string, infrastructureOutputs: Record<string, unknown>) {
    return { projectId, albArn: infrastructureOutputs.alb_arn || null };
  }

  async createOrUpdateTargetGroup(projectId: string, healthCheckPath: string, appPort: number) {
    return { projectId, healthCheckPath, appPort, status: "terraform_managed" };
  }

  async createOrUpdateListener(projectId: string) {
    return { projectId, status: "terraform_managed" };
  }

  async getTargetHealth(projectId: string) {
    const deployment = await this.deploymentRepository.findOne({
      where: { projectId },
      order: { createdAt: "DESC" },
    });

    if (!deployment?.targetGroupArn) {
      return {
        targetGroupArn: null,
        healthCheckPath: deployment?.healthCheckPath || "/health",
        status: "not_configured",
        albDnsName: deployment?.albDnsName || null,
        healthyCount: 0,
        unhealthyCount: 0,
        targetStates: [],
      };
    }

    const health = await this.describeTargetHealth(deployment.targetGroupArn).catch((error) =>
      this.unhealthyResult(deployment.targetGroupArn, this.failureReason(error, "Failed to describe ALB target health."))
    );

    return {
      ...health,
      status: health.healthy ? "healthy" : "unhealthy",
      healthCheckPath: deployment.healthCheckPath || "/health",
      albDnsName: deployment.albDnsName || null,
    };
  }

  async waitForHealthyTargets(projectId: string): Promise<AlbHealthResult> {
    const deployment = await this.deploymentRepository.findOne({
      where: { projectId },
      order: { createdAt: "DESC" },
    });
    const config = getOrchestrationConfig(this.config);
    const timeoutMs = config.albHealthTimeoutSeconds * 1000;
    const pollMs = config.albHealthPollIntervalSeconds * 1000;
    const startedAt = Date.now();
    const targetGroupArn = deployment?.targetGroupArn || null;

    await this.event(projectId, deployment?.pipelineRunId || null, deployment?.id || null, "alb_health_check_wait_started", "running", "Waiting for ALB target health.");
    await this.audit("ALB_HEALTH_CHECK_WAIT_STARTED", projectId, "success", { deploymentId: deployment?.id });

    if (!targetGroupArn) {
      const missing = this.unhealthyResult(null, "ALB target group ARN is missing.");
      await this.event(projectId, deployment?.pipelineRunId || null, deployment?.id || null, "alb_health_check_failed", "failed", missing.reason!, missing);
      await this.audit("ALB_HEALTH_CHECK_FAILED", projectId, "failed", missing);
      return missing;
    }

    while (Date.now() - startedAt <= timeoutMs) {
      let result: AlbHealthResult;

      try {
        result = await this.describeTargetHealth(targetGroupArn);
      } catch (error) {
        result = this.unhealthyResult(targetGroupArn, this.failureReason(error, "Failed to describe ALB target health."));
        await this.event(projectId, deployment?.pipelineRunId || null, deployment?.id || null, "alb_health_check_failed", "failed", result.reason!, result);
        await this.audit("ALB_HEALTH_CHECK_FAILED", projectId, "failed", result);
        return result;
      }

      await this.event(projectId, deployment?.pipelineRunId || null, deployment?.id || null, "alb_target_health_check", result.healthy ? "success" : "running", result.reason || "ALB target health checked.", result);
      await this.audit("ALB_TARGET_HEALTH_CHECKED", projectId, "success", result);

      if (result.healthy) {
        await this.event(projectId, deployment?.pipelineRunId || null, deployment?.id || null, "alb_targets_healthy", "success", "ALB targets are healthy.", result);
        await this.audit("ALB_TARGETS_HEALTHY", projectId, "success", result);
        return result;
      }

      await this.sleep(pollMs);
    }

    const timeout = await this.describeTargetHealth(targetGroupArn).catch(() =>
      this.unhealthyResult(targetGroupArn, "Timed out waiting for ALB targets to become healthy.")
    );
    timeout.healthy = false;
    timeout.reason = timeout.reason || "Timed out waiting for ALB targets to become healthy.";
    await this.event(projectId, deployment?.pipelineRunId || null, deployment?.id || null, "alb_health_check_timeout", "failed", timeout.reason, timeout);
    await this.audit("ALB_HEALTH_CHECK_TIMEOUT", projectId, "failed", timeout);
    return timeout;
  }

  private async describeTargetHealth(targetGroupArn: string): Promise<AlbHealthResult> {
    const response = await this.elbClient().send(
      new DescribeTargetHealthCommand({ TargetGroupArn: targetGroupArn })
    );
    const targetStates = (response.TargetHealthDescriptions || []).map((target) => ({
      targetId: target.Target?.Id || null,
      port: target.Target?.Port || null,
      state: target.TargetHealth?.State || null,
      reason: target.TargetHealth?.Reason || null,
      description: target.TargetHealth?.Description || null,
    }));
    const healthyCount = targetStates.filter((target) => target.state === "healthy").length;
    const unhealthyCount = targetStates.filter((target) => target.state && target.state !== "healthy").length;
    const healthy = targetStates.length > 0 && healthyCount === targetStates.length && unhealthyCount === 0;

    return {
      healthy,
      reason: healthy
        ? undefined
        : targetStates.length === 0
          ? "No ALB targets are registered yet."
          : "One or more ALB targets are not healthy.",
      targetGroupArn,
      healthyCount,
      unhealthyCount,
      targetStates,
      checkedAt: new Date().toISOString(),
    };
  }

  private unhealthyResult(targetGroupArn: string | null, reason: string): AlbHealthResult {
    return {
      healthy: false,
      reason,
      targetGroupArn,
      healthyCount: 0,
      unhealthyCount: 0,
      targetStates: [],
      checkedAt: new Date().toISOString(),
    };
  }

  private elbClient() {
    return new ElasticLoadBalancingV2Client({
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
      "healthy",
      "reason",
      "targetGroupArn",
      "healthyCount",
      "unhealthyCount",
      "targetStates",
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
