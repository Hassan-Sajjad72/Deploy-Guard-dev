import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { Queue } from "bullmq";
import { ConfigService } from "@nestjs/config";
import { InjectRepository } from "@nestjs/typeorm";
import { Request } from "express";
import { Repository } from "typeorm";
import { AuditLogService } from "../audit-log/audit-log.service";
import { ProjectDetectionProfile } from "../projects/project-detection-profile.entity";
import { ProjectPipelineEvent } from "../projects/project-pipeline-event.entity";
import {
  PipelineRunStatus,
  ProjectPipelineRun,
} from "../projects/project-pipeline-run.entity";
import { ProjectPreflightReport } from "../projects/project-preflight-report.entity";
import { Project, ProjectStatus, ProjectVisibility } from "../projects/project.entity";
import {
  PIPELINE_QUEUE,
  PipelineJobData,
} from "../projects/pipeline/pipeline.types";
import { User, UserRole } from "../users/user.entity";
import { ProjectPersistentStorage } from "../storage/project-persistent-storage.entity";
import { getFinopsConfig } from "./finops.config";
import { FinopsPolicyService } from "./finops-policy.service";
import { InfracostService, NormalizedCostResource } from "./infracost.service";
import {
  CostEstimateSource,
  CostEstimateStatus,
  ProjectCostEstimate,
} from "./project-cost-estimate.entity";
import {
  CostResourceType,
  ProjectCostResourceBreakdown,
} from "./project-cost-resource-breakdown.entity";
import {
  ProjectCostSettings,
  SubscriptionTier,
} from "./project-cost-settings.entity";
import { TerraformCostPlanService } from "./terraform-cost-plan.service";

type RequestInfo = Request | undefined;

type GenerateEstimateInput = {
  project: Project;
  actorUser?: User | null;
  pipelineRun?: ProjectPipelineRun | null;
  req?: RequestInfo;
};

type PolicyResult = {
  status: CostEstimateStatus;
  approvalRequired: boolean;
  blockedByTierLimit: boolean;
  tierLimitMonthlyCost: number;
  upgradePromptMessage: string | null;
};

const SAFE_COST_METADATA_KEYS = [
  "projectId",
  "pipelineRunId",
  "estimateId",
  "source",
  "status",
  "currency",
  "totalMonthlyCost",
  "monthlyCostDifference",
  "subscriptionTier",
  "tierLimitMonthlyCost",
  "warningThresholdMonthlyCost",
  "approvalRequired",
  "blockedByTierLimit",
  "resourceCount",
  "reason",
];

@Injectable()
export class FinopsService {
  constructor(
    @InjectRepository(Project)
    private readonly projectRepository: Repository<Project>,
    @InjectRepository(ProjectDetectionProfile)
    private readonly profileRepository: Repository<ProjectDetectionProfile>,
    @InjectRepository(ProjectPreflightReport)
    private readonly preflightRepository: Repository<ProjectPreflightReport>,
    @InjectRepository(ProjectPipelineRun)
    private readonly runRepository: Repository<ProjectPipelineRun>,
    @InjectRepository(ProjectPipelineEvent)
    private readonly eventRepository: Repository<ProjectPipelineEvent>,
    @InjectRepository(ProjectCostEstimate)
    private readonly estimateRepository: Repository<ProjectCostEstimate>,
    @InjectRepository(ProjectCostResourceBreakdown)
    private readonly breakdownRepository: Repository<ProjectCostResourceBreakdown>,
    @InjectRepository(ProjectCostSettings)
    private readonly settingsRepository: Repository<ProjectCostSettings>,
    @InjectRepository(ProjectPersistentStorage)
    private readonly storageRepository: Repository<ProjectPersistentStorage>,
    @Inject(PIPELINE_QUEUE)
    private readonly pipelineQueue: Queue<PipelineJobData>,
    private readonly config: ConfigService,
    private readonly auditLogService: AuditLogService,
    private readonly policyService: FinopsPolicyService,
    private readonly infracostService: InfracostService,
    private readonly terraformCostPlanService: TerraformCostPlanService
  ) {}

  async createEstimate(user: User, projectId: string, req?: RequestInfo) {
    const project = await this.findProjectForManage(user, projectId);
    const estimate = await this.generateEstimate({ project, actorUser: user, req });

    return this.toEstimateResponse(estimate);
  }

  async generatePipelineEstimate(input: GenerateEstimateInput) {
    return this.generateEstimate(input);
  }

  async listEstimates(user: User, projectId: string) {
    const project = await this.findProjectForView(user, projectId);
    const estimates = await this.estimateRepository.find({
      where: { projectId: project.id },
      order: { createdAt: "DESC" },
      take: 50,
    });

    return estimates.map((estimate) => this.toEstimateResponse(estimate));
  }

  async getLatestEstimate(user: User, projectId: string) {
    const project = await this.findProjectForView(user, projectId);
    const estimate = await this.estimateRepository.findOne({
      where: { projectId: project.id },
      order: { createdAt: "DESC" },
      relations: { breakdowns: true },
    });

    return estimate ? this.toEstimateResponse(estimate) : null;
  }

  async getEstimate(user: User, projectId: string, estimateId: string) {
    const project = await this.findProjectForView(user, projectId);
    const estimate = await this.findEstimate(project.id, estimateId);

    return this.toEstimateResponse(estimate);
  }

  async getSettings(user: User, projectId: string) {
    const project = await this.findProjectForView(user, projectId);
    const settings = await this.getOrCreateSettings(project.id);

    return this.toSettingsResponse(settings);
  }

  async updateSettings(
    user: User,
    projectId: string,
    dto: Record<string, unknown>,
    req?: RequestInfo
  ) {
    const project = await this.findProjectForManage(user, projectId);
    const settings = await this.getOrCreateSettings(project.id);
    const config = getFinopsConfig(this.config);

    if (dto.subscriptionTier !== undefined) {
      if (user.role !== UserRole.ADMIN) {
        throw new ForbiddenException("Only admins can update subscription tier.");
      }

      if (!Object.values(SubscriptionTier).includes(dto.subscriptionTier as SubscriptionTier)) {
        throw new BadRequestException("Invalid subscription tier.");
      }

      settings.subscriptionTier = dto.subscriptionTier as SubscriptionTier;
    }

    if (dto.warningThresholdMonthlyCost !== undefined) {
      const threshold = Number(dto.warningThresholdMonthlyCost);

      if (!Number.isFinite(threshold) || threshold < 0) {
        throw new BadRequestException("Warning threshold must be a positive number.");
      }

      settings.warningThresholdMonthlyCost = threshold;
    }

    settings.currency = String(dto.currency || settings.currency || config.currency);
    settings.updatedByUserId = user.id;

    const saved = await this.settingsRepository.save(settings);
    await this.audit("COST_SETTINGS_UPDATED", project, user, "success", {
      projectId: project.id,
      subscriptionTier: saved.subscriptionTier,
      warningThresholdMonthlyCost: saved.warningThresholdMonthlyCost,
      currency: saved.currency,
      status: "success",
    }, req);

    return this.toSettingsResponse(saved);
  }

  async approveEstimate(
    user: User,
    projectId: string,
    estimateId: string,
    req?: RequestInfo
  ) {
    const project = await this.findProjectForManage(user, projectId);
    const estimate = await this.findEstimate(project.id, estimateId);

    if (!this.policyService.canApprove(estimate)) {
      throw new BadRequestException("Only cost estimates requiring approval can be approved.");
    }

    estimate.status = CostEstimateStatus.APPROVED;
    estimate.approvedByUserId = user.id;
    estimate.approvedAt = new Date();
    estimate.approvalRequired = false;
    const saved = await this.estimateRepository.save(estimate);

    await this.pipelineEvent(saved, "cost_approved", "success", "Cost estimate approved.");
    await this.audit("COST_APPROVED", project, user, "success", {
      projectId: project.id,
      pipelineRunId: saved.pipelineRunId,
      estimateId: saved.id,
      status: saved.status,
      totalMonthlyCost: saved.totalMonthlyCost,
      subscriptionTier: saved.subscriptionTier,
    }, req);

    if (saved.pipelineRunId) {
      await this.updatePipelineStatus(saved.pipelineRunId, {
        status: PipelineRunStatus.QUEUED,
        currentStage: "cost_approved",
      });
      await this.resumePipelineAfterCostApproval(
        project.id,
        saved.pipelineRunId,
        saved.id,
        user.id
      );
    }

    return this.toEstimateResponse(saved);
  }

  async resumePipelineAfterCostApproval(
    projectId: string,
    pipelineRunId: string,
    estimateId: string,
    triggeredByUserId: number
  ) {
    const run = await this.runRepository.findOne({
      where: { id: pipelineRunId, projectId },
    });

    if (!run) {
      throw new NotFoundException("Pipeline run for cost approval was not found.");
    }

    await this.pipelineQueue.add(
      "resumeAfterCostApproval",
      {
        pipelineRunId,
        projectId,
        triggeredByUserId,
        jobType: "resume_after_cost_approval",
        options: {
          triggerGithubActions: false,
          buildImage: false,
          pushToEcr: false,
          runTerraform: true,
        },
      },
      {
        jobId: `cost-approval-${estimateId}`,
        attempts: Number(process.env.PIPELINE_JOB_ATTEMPTS || "1"),
        backoff: { type: "fixed", delay: 5000 },
      }
    );

    await this.pipelineEvent(
      { ...run, id: estimateId, pipelineRunId } as unknown as ProjectCostEstimate,
      "pipeline_resume_queued",
      "queued",
      "Pipeline queued to resume after cost approval."
    );

    return { projectId, pipelineRunId, estimateId, status: "queued" };
  }

  async rejectEstimate(
    user: User,
    projectId: string,
    estimateId: string,
    dto: Record<string, unknown>,
    req?: RequestInfo
  ) {
    const project = await this.findProjectForManage(user, projectId);
    const estimate = await this.findEstimate(project.id, estimateId);

    if (!this.policyService.canReject(estimate)) {
      throw new BadRequestException("Only cost estimates requiring approval can be rejected.");
    }

    estimate.status = CostEstimateStatus.REJECTED;
    estimate.rejectedByUserId = user.id;
    estimate.rejectedAt = new Date();
    estimate.rejectionReason = String(dto.reason || "Rejected by reviewer.");
    estimate.approvalRequired = false;
    const saved = await this.estimateRepository.save(estimate);

    await this.pipelineEvent(saved, "cost_rejected", "failed", "Cost estimate rejected.");
    await this.audit("COST_REJECTED", project, user, "success", {
      projectId: project.id,
      pipelineRunId: saved.pipelineRunId,
      estimateId: saved.id,
      status: saved.status,
      totalMonthlyCost: saved.totalMonthlyCost,
      subscriptionTier: saved.subscriptionTier,
    }, req);

    if (saved.pipelineRunId) {
      await this.updatePipelineStatus(saved.pipelineRunId, {
        status: PipelineRunStatus.COST_REJECTED,
        currentStage: "cost_rejected",
        failedAt: new Date(),
        errorMessage: "Cost estimate rejected.",
      });
    }

    return this.toEstimateResponse(saved);
  }

  private async generateEstimate(input: GenerateEstimateInput) {
    const { project, actorUser, pipelineRun, req } = input;
    const config = getFinopsConfig(this.config);
    const settings = await this.getOrCreateSettings(project.id);
    const previousEstimate = await this.estimateRepository.findOne({
      where: { projectId: project.id },
      order: { createdAt: "DESC" },
    });

    let estimate = await this.estimateRepository.save(
      this.estimateRepository.create({
        projectId: project.id,
        pipelineRunId: pipelineRun?.id || null,
        createdByUserId: actorUser?.id || null,
        status: CostEstimateStatus.CALCULATING,
        source: config.mockMode ? CostEstimateSource.MOCK : CostEstimateSource.INFRACOST,
        currency: settings.currency || config.currency,
        previousMonthlyCost: previousEstimate?.totalMonthlyCost || 0,
        subscriptionTier: settings.subscriptionTier,
        warningThresholdMonthlyCost: settings.warningThresholdMonthlyCost,
        metadata: { mode: config.mockMode ? "mock" : "real" },
      })
    );

    await this.pipelineEvent(estimate, "cost_analysis_started", "running", "Cost analysis started.");
    await this.audit("COST_ANALYSIS_STARTED", project, actorUser || null, "success", {
      projectId: project.id,
      pipelineRunId: pipelineRun?.id,
      estimateId: estimate.id,
      source: estimate.source,
      status: estimate.status,
    }, req);

    try {
      const result = config.mockMode
        ? await this.generateMockBreakdown(project, estimate, actorUser || null, req)
        : await this.generateRealBreakdown(project, estimate, actorUser || null, req);
      const totalMonthlyCost = this.roundMoney(
        result.resources.reduce((sum, resource) => sum + resource.monthlyCost, 0)
      );
      const policy = this.policyService.evaluate({
        totalMonthlyCost,
        warningThresholdMonthlyCost: settings.warningThresholdMonthlyCost,
        subscriptionTier: settings.subscriptionTier,
      }) as PolicyResult;

      estimate.totalMonthlyCost = totalMonthlyCost;
      estimate.monthlyCostDifference = this.roundMoney(
        totalMonthlyCost - (estimate.previousMonthlyCost || 0)
      );
      estimate.tierLimitMonthlyCost = policy.tierLimitMonthlyCost;
      estimate.status = policy.status;
      estimate.approvalRequired = policy.approvalRequired;
      estimate.blockedByTierLimit = policy.blockedByTierLimit;
      estimate.upgradePromptMessage = policy.upgradePromptMessage;
      estimate.terraformPlanSummary = result.terraformPlanSummary;
      estimate.rawInfracostResponse = result.rawInfracostResponse;
      estimate.normalizedBreakdown = {
        resources: result.resources.map((resource) => ({
          resourceType: resource.resourceType,
          resourceName: resource.resourceName,
          monthlyCost: resource.monthlyCost,
        })),
      };
      estimate.metadata = {
        mode: config.mockMode ? "mock" : "real",
        resourceCount: result.resources.length,
      };
      estimate = await this.estimateRepository.save(estimate);

      await this.saveBreakdowns(estimate, result.resources);
      estimate.breakdowns = await this.breakdownRepository.find({
        where: { estimateId: estimate.id },
        order: { monthlyCost: "DESC" },
      });

      await this.pipelineEvent(estimate, "cost_breakdown_processed", "success", "Cost breakdown processed.", {
        estimateId: estimate.id,
        resourceCount: result.resources.length,
        totalMonthlyCost,
      });
      await this.audit("COST_BREAKDOWN_PROCESSED", project, actorUser || null, "success", {
        projectId: project.id,
        pipelineRunId: pipelineRun?.id,
        estimateId: estimate.id,
        resourceCount: result.resources.length,
        totalMonthlyCost,
      }, req);

      await this.pipelineEvent(estimate, "cost_policy_evaluated", "success", "Cost policy evaluated.", {
        estimateId: estimate.id,
        status: estimate.status,
        approvalRequired: estimate.approvalRequired,
        blockedByTierLimit: estimate.blockedByTierLimit,
        totalMonthlyCost,
        subscriptionTier: estimate.subscriptionTier,
        tierLimitMonthlyCost: estimate.tierLimitMonthlyCost,
        warningThresholdMonthlyCost: estimate.warningThresholdMonthlyCost,
      });
      await this.audit("COST_POLICY_EVALUATED", project, actorUser || null, "success", {
        projectId: project.id,
        pipelineRunId: pipelineRun?.id,
        estimateId: estimate.id,
        status: estimate.status,
        totalMonthlyCost,
        subscriptionTier: estimate.subscriptionTier,
        approvalRequired: estimate.approvalRequired,
        blockedByTierLimit: estimate.blockedByTierLimit,
      }, req);

      if (estimate.blockedByTierLimit) {
        await this.pipelineEvent(
          estimate,
          "deployment_blocked_by_cost_limit",
          "failed",
          estimate.upgradePromptMessage || "Estimated monthly cost exceeds tier limit.",
          { estimateId: estimate.id, totalMonthlyCost, tierLimitMonthlyCost: estimate.tierLimitMonthlyCost }
        );
        await this.audit("DEPLOYMENT_BLOCKED_BY_COST_LIMIT", project, actorUser || null, "failed", {
          projectId: project.id,
          pipelineRunId: pipelineRun?.id,
          estimateId: estimate.id,
          status: estimate.status,
          totalMonthlyCost,
          tierLimitMonthlyCost: estimate.tierLimitMonthlyCost,
        }, req);
      } else if (estimate.approvalRequired) {
        await this.pipelineEvent(estimate, "cost_approval_required", "waiting", "Cost estimate requires approval.", {
          estimateId: estimate.id,
          totalMonthlyCost,
          warningThresholdMonthlyCost: estimate.warningThresholdMonthlyCost,
        });
        await this.pipelineEvent(estimate, "cost_threshold_warning", "warning", "Estimated monthly cost exceeds the warning threshold.", {
          estimateId: estimate.id,
          totalMonthlyCost,
          warningThresholdMonthlyCost: estimate.warningThresholdMonthlyCost,
        });
        await this.audit("COST_APPROVAL_REQUIRED", project, actorUser || null, "success", {
          projectId: project.id,
          pipelineRunId: pipelineRun?.id,
          estimateId: estimate.id,
          status: estimate.status,
          totalMonthlyCost,
          warningThresholdMonthlyCost: estimate.warningThresholdMonthlyCost,
        }, req);
      } else {
        await this.pipelineEvent(estimate, "cost_analysis_passed", "success", "Cost policy passed.", {
          estimateId: estimate.id,
          totalMonthlyCost,
        });
      }

      return estimate;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Cost analysis failed.";
      estimate.status = CostEstimateStatus.FAILED;
      estimate.errorMessage = this.publicErrorMessage(message);
      estimate = await this.estimateRepository.save(estimate);
      await this.pipelineEvent(estimate, "cost_analysis_failed", "failed", estimate.errorMessage, {
        estimateId: estimate.id,
        reason: estimate.errorMessage,
      });
      await this.audit("COST_ANALYSIS_FAILED", project, actorUser || null, "failed", {
        projectId: project.id,
        pipelineRunId: pipelineRun?.id,
        estimateId: estimate.id,
        status: estimate.status,
        reason: estimate.errorMessage,
      }, req);
      throw error;
    }
  }

  private async generateMockBreakdown(
    project: Project,
    estimate: ProjectCostEstimate,
    actorUser: User | null,
    req?: RequestInfo
  ) {
    const config = getFinopsConfig(this.config);
    const profile = await this.profileRepository.findOne({
      where: { projectId: project.id },
    });

    if (!profile) {
      throw new BadRequestException("Run stack detection before generating a cost estimate.");
    }

    const preflight = await this.preflightRepository.findOne({
      where: { projectId: project.id },
    });

    if (!preflight) {
      throw new BadRequestException("Generate a pre-flight report before generating a cost estimate.");
    }

    const framework = (profile?.framework || profile?.ecosystem || "app").toLowerCase();
    const computeCost = framework.includes("next") || framework.includes("django") ? 35 : 18;
    const storage = await this.storageRepository.findOne({
      where: { projectId: project.id, environmentName: "dev" },
      order: { createdAt: "DESC" },
    });
    const efsRequired = Boolean(profile?.requiresPersistentStorage || storage?.enabled || storage?.userEnabled);
    const resources: NormalizedCostResource[] = [
      {
        resourceType: CostResourceType.ECS_FARGATE_COMPUTE,
        resourceName: `${project.name}-service`,
        serviceName: "Amazon ECS on Fargate",
        monthlyCost: computeCost,
        metadata: {
          source: "mock",
          assumption: "small always-on service",
          cpu: "0.25 vCPU",
          memory: "0.5 GB",
          runningHours: 730,
        },
      },
      {
        resourceType: CostResourceType.LOAD_BALANCER,
        resourceName: `${project.name}-alb`,
        serviceName: "Application Load Balancer",
        monthlyCost: 18,
        metadata: { source: "mock", assumption: "dedicated ALB estimate" },
      },
      {
        resourceType: CostResourceType.STORAGE,
        resourceName: `${project.name}-ecr-logs`,
        serviceName: "ECR and log storage",
        monthlyCost: efsRequired ? 8 : 3,
        metadata: { source: "mock", assumption: "ECR image storage and small logs" },
      },
      {
        resourceType: CostResourceType.DATA_TRANSFER,
        resourceName: `${project.name}-data-transfer`,
        serviceName: "Data transfer",
        monthlyCost: 5,
        metadata: { source: "mock", assumedGbPerMonth: 50 },
      },
      {
        resourceType: CostResourceType.CLOUDWATCH_LOGS,
        resourceName: `${project.name}-logs`,
        serviceName: "CloudWatch Logs",
        monthlyCost: 4,
        metadata: { source: "mock", assumedGbPerMonth: 5 },
      },
    ];

    if (profile?.requiresDatabase) {
      resources.push({
        resourceType: CostResourceType.DATABASE,
        resourceName: `${project.name}-${profile.databaseType || "database"}`,
        serviceName: "Managed database",
        monthlyCost: 25,
        metadata: { source: "mock", databaseType: profile.databaseType || "unknown" },
      });
    }

    if (efsRequired) {
      resources.push(
        {
          resourceType: CostResourceType.STORAGE,
          resourceName: `${project.name}-efs`,
          serviceName: "Amazon EFS",
          monthlyCost: 12,
          metadata: {
            source: "mock",
            assumption: "small persistent file share",
            storageEnabled: Boolean(storage?.enabled || storage?.userEnabled),
            requiredByDetection: Boolean(profile?.requiresPersistentStorage),
          },
        },
        {
          resourceType: CostResourceType.STORAGE,
          resourceName: `${project.name}-efs-backup`,
          serviceName: "AWS Backup",
          monthlyCost: storage?.backupEnabled === false ? 0 : 4,
          metadata: {
            source: "mock",
            assumption: "daily retained EFS backup baseline",
            backupEnabled: storage?.backupEnabled !== false,
          },
        },
        {
          resourceType: CostResourceType.STORAGE,
          resourceName: `${project.name}-efs-kms`,
          serviceName: "AWS KMS",
          monthlyCost: 1,
          metadata: { source: "mock", assumption: "customer managed EFS KMS key" },
        }
      );
    }

    await this.pipelineEvent(estimate, "mock_cost_estimate_generated", "success", "Mock cost estimate generated.", {
      estimateId: estimate.id,
      resourceCount: resources.length,
      source: CostEstimateSource.MOCK,
    });
    await this.audit("MOCK_COST_ESTIMATE_GENERATED", project, actorUser, "success", {
      projectId: project.id,
      pipelineRunId: estimate.pipelineRunId,
      estimateId: estimate.id,
      resourceCount: resources.length,
      source: CostEstimateSource.MOCK,
      status: "success",
    }, req);

    return {
      resources,
      terraformPlanSummary: {
        source: "mock",
        mock: true,
        reason:
          "FINOPS_MOCK_MODE is enabled because real Terraform/Infracost integration is not configured yet.",
        currency: config.currency,
        profileId: profile?.id || null,
        framework: profile?.framework || null,
        requiresDatabase: Boolean(profile?.requiresDatabase),
        requiresPersistentStorage: efsRequired,
      },
      rawInfracostResponse: null,
    };
  }

  private async generateRealBreakdown(
    project: Project,
    estimate: ProjectCostEstimate,
    actorUser: User | null,
    req?: RequestInfo
  ) {
    const config = getFinopsConfig(this.config);

    if (!config.enableRealTerraform) {
      throw new Error("Terraform modules are not configured for cost estimation.");
    }

    await this.pipelineEvent(estimate, "terraform_plan_started", "running", "Terraform cost plan started.");
    const plan = await this.terraformCostPlanService.generateTerraformPlan(project);
    const planJson = await this.terraformCostPlanService.convertTerraformPlanToJson(
      plan.planPath,
      plan.workdir
    );
    await this.pipelineEvent(estimate, "terraform_plan_generated", "success", "Terraform plan JSON generated.");
    await this.audit("TERRAFORM_COST_PLAN_GENERATED", project, actorUser, "success", {
      projectId: project.id,
      pipelineRunId: estimate.pipelineRunId,
      estimateId: estimate.id,
      status: "success",
    }, req);

    await this.pipelineEvent(estimate, "infracost_estimate_started", "running", "Infracost estimate started.");
    await this.audit("INFRACOST_ESTIMATE_STARTED", project, actorUser, "success", {
      projectId: project.id,
      pipelineRunId: estimate.pipelineRunId,
      estimateId: estimate.id,
      source: CostEstimateSource.INFRACOST,
      status: "running",
    }, req);
    const rawOutput = await this.infracostService.runInfracostBreakdown(planJson, plan.workdir);
    const parsed = this.infracostService.parseInfracostResponse(rawOutput);
    const resources = this.infracostService.normalizeCostBreakdown(parsed);
    await this.pipelineEvent(estimate, "infracost_estimate_generated", "success", "Infracost estimate generated.", {
      estimateId: estimate.id,
      resourceCount: resources.length,
    });
    await this.audit("INFRACOST_ESTIMATE_GENERATED", project, actorUser, "success", {
      projectId: project.id,
      pipelineRunId: estimate.pipelineRunId,
      estimateId: estimate.id,
      resourceCount: resources.length,
      source: CostEstimateSource.INFRACOST,
      status: "success",
    }, req);

    return {
      resources,
      terraformPlanSummary: { source: "terraform", planPath: "tfplan" },
      rawInfracostResponse: parsed,
    };
  }

  private async saveBreakdowns(
    estimate: ProjectCostEstimate,
    resources: NormalizedCostResource[]
  ) {
    await this.breakdownRepository.delete({ estimateId: estimate.id });
    const breakdowns = resources.map((resource) =>
      this.breakdownRepository.create({
        estimateId: estimate.id,
        projectId: estimate.projectId,
        pipelineRunId: estimate.pipelineRunId,
        resourceType: resource.resourceType,
        resourceName: resource.resourceName,
        provider: "aws",
        serviceName: resource.serviceName || null,
        monthlyCost: this.roundMoney(resource.monthlyCost),
        hourlyCost: resource.hourlyCost || null,
        unit: resource.unit || null,
        quantity: resource.quantity || null,
        metadata: resource.metadata || null,
      })
    );

    if (breakdowns.length > 0) {
      await this.breakdownRepository.save(breakdowns);
    }
  }

  private async getOrCreateSettings(projectId: string) {
    const existing = await this.settingsRepository.findOne({ where: { projectId } });

    if (existing) {
      return existing;
    }

    const config = getFinopsConfig(this.config);
    return this.settingsRepository.save(
      this.settingsRepository.create({
        projectId,
        subscriptionTier: SubscriptionTier.FREE,
        warningThresholdMonthlyCost: config.defaultWarningThreshold,
        currency: config.currency,
      })
    );
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

  private async findEstimate(projectId: string, estimateId: string) {
    const estimate = await this.estimateRepository.findOne({
      where: { id: estimateId, projectId },
      relations: { breakdowns: true },
    });

    if (!estimate) {
      throw new NotFoundException("Cost estimate not found");
    }

    return estimate;
  }

  private async pipelineEvent(
    estimate: ProjectCostEstimate,
    stage: string,
    status: string,
    message: string,
    metadata: Record<string, unknown> = {}
  ) {
    if (!estimate.pipelineRunId) {
      return;
    }

    await this.eventRepository.save(
      this.eventRepository.create({
        pipelineRunId: estimate.pipelineRunId,
        projectId: estimate.projectId,
        stage,
        status,
        message,
        metadata: this.safeMetadata({
          projectId: estimate.projectId,
          pipelineRunId: estimate.pipelineRunId,
          estimateId: estimate.id,
          stage,
          status,
          ...metadata,
        }),
      })
    );
  }

  private async audit(
    action: string,
    project: Project,
    actorUser: User | null,
    status: string,
    metadata: Record<string, unknown>,
    req?: RequestInfo
  ) {
    await this.auditLogService.record({
      actorUser,
      action,
      resourceType: "cost_estimate",
      resourceId: metadata.estimateId ? String(metadata.estimateId) : project.id,
      status,
      metadata: this.safeMetadata(metadata),
      req,
    });
  }

  private safeMetadata(metadata: Record<string, unknown>) {
    return Object.entries(metadata).reduce(
      (safe, [key, value]) => {
        if (SAFE_COST_METADATA_KEYS.includes(key) && value !== undefined) {
          safe[key] = value;
        }

        return safe;
      },
      {} as Record<string, unknown>
    );
  }

  private async updatePipelineStatus(
    pipelineRunId: string,
    patch: Partial<ProjectPipelineRun>
  ) {
    const run = await this.runRepository.findOne({ where: { id: pipelineRunId } });

    if (!run) {
      return;
    }

    Object.assign(run, patch);
    await this.runRepository.save(run);
  }

  private roundMoney(value: number) {
    return Math.round((Number(value) || 0) * 100) / 100;
  }

  private publicErrorMessage(message: string) {
    if (/token|secret|password|credential|authorization|api.?key/i.test(message)) {
      return "Cost analysis failed because required cost analysis configuration is invalid or missing.";
    }

    return message;
  }

  private toSettingsResponse(settings: ProjectCostSettings) {
    return {
      id: settings.id,
      projectId: settings.projectId,
      subscriptionTier: settings.subscriptionTier,
      warningThresholdMonthlyCost: settings.warningThresholdMonthlyCost,
      currency: settings.currency,
      updatedByUserId: settings.updatedByUserId,
      createdAt: settings.createdAt,
      updatedAt: settings.updatedAt,
    };
  }

  private toEstimateResponse(estimate: ProjectCostEstimate) {
    const finopsConfig = getFinopsConfig(this.config);
    const legacyTierWarning =
      !finopsConfig.enforceTierLimits &&
      estimate.status === CostEstimateStatus.BLOCKED_BY_TIER_LIMIT;
    return {
      id: estimate.id,
      projectId: estimate.projectId,
      pipelineRunId: estimate.pipelineRunId,
      createdByUserId: estimate.createdByUserId,
      status: legacyTierWarning
        ? CostEstimateStatus.WARNING_OVER_TIER
        : estimate.status,
      source: estimate.source,
      mode: estimate.source === CostEstimateSource.MOCK ? "mock" : "real",
      tierEnforcement: finopsConfig.enforceTierLimits,
      currency: estimate.currency,
      totalMonthlyCost: estimate.totalMonthlyCost,
      previousMonthlyCost: estimate.previousMonthlyCost,
      monthlyCostDifference: estimate.monthlyCostDifference,
      tierLimitMonthlyCost: estimate.tierLimitMonthlyCost,
      warningThresholdMonthlyCost: estimate.warningThresholdMonthlyCost,
      subscriptionTier: estimate.subscriptionTier,
      approvalRequired: estimate.approvalRequired,
      blockedByTierLimit: legacyTierWarning ? false : estimate.blockedByTierLimit,
      upgradePromptMessage: legacyTierWarning
        ? "Estimated cost exceeds the configured tier, but Tier Enforcement is Off."
        : estimate.upgradePromptMessage,
      errorMessage: estimate.errorMessage,
      approvedByUserId: estimate.approvedByUserId,
      approvedAt: estimate.approvedAt,
      rejectedByUserId: estimate.rejectedByUserId,
      rejectedAt: estimate.rejectedAt,
      rejectionReason: estimate.rejectionReason,
      breakdowns: (estimate.breakdowns || []).map((breakdown) => ({
        id: breakdown.id,
        resourceType: breakdown.resourceType,
        resourceName: breakdown.resourceName,
        provider: breakdown.provider,
        serviceName: breakdown.serviceName,
        monthlyCost: breakdown.monthlyCost,
        hourlyCost: breakdown.hourlyCost,
        unit: breakdown.unit,
        quantity: breakdown.quantity,
      })),
      createdAt: estimate.createdAt,
      updatedAt: estimate.updatedAt,
    };
  }
}
