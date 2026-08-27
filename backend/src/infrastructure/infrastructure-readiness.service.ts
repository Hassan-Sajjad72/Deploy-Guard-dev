import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectRepository } from "@nestjs/typeorm";
import { existsSync } from "fs";
import { Repository } from "typeorm";
import { CostEstimateStatus, ProjectCostEstimate } from "../finops/project-cost-estimate.entity";
import { getFinopsConfig } from "../finops/finops.config";
import { ProjectDeploymentContract } from "../projects/project-deployment-contract.entity";
import {
  PreflightValidationStatus,
  ProjectPreflightReport,
} from "../projects/project-preflight-report.entity";
import {
  PipelineRunStatus,
  ProjectPipelineRun,
} from "../projects/project-pipeline-run.entity";
import { Project, ProjectStatus, ProjectVisibility } from "../projects/project.entity";
import { User, UserRole } from "../users/user.entity";
import { getInfrastructureConfig } from "./infrastructure.config";
import { externalCiRequired } from "../config/env-parsing";
import {
  InfrastructureEnvironmentStatus,
  ProjectInfrastructureEnvironment,
} from "./project-infrastructure-environment.entity";
import { PipelineActivityService } from "../projects/pipeline/pipeline-activity.service";

export type DeploymentReadinessCheck = {
  key: string;
  label: string;
  status: "passed" | "failed" | "missing" | "warning";
  blocking: boolean;
  message: string;
};

@Injectable()
export class InfrastructureReadinessService {
  constructor(
    @InjectRepository(Project)
    private readonly projectRepository: Repository<Project>,
    @InjectRepository(ProjectDeploymentContract)
    private readonly contractRepository: Repository<ProjectDeploymentContract>,
    @InjectRepository(ProjectPreflightReport)
    private readonly preflightRepository: Repository<ProjectPreflightReport>,
    @InjectRepository(ProjectPipelineRun)
    private readonly runRepository: Repository<ProjectPipelineRun>,
    @InjectRepository(ProjectCostEstimate)
    private readonly costEstimateRepository: Repository<ProjectCostEstimate>,
    @InjectRepository(ProjectInfrastructureEnvironment)
    private readonly environmentRepository: Repository<ProjectInfrastructureEnvironment>,
    private readonly pipelineActivity: PipelineActivityService,
    private readonly config: ConfigService
  ) {}

  async getDeploymentReadiness(projectId: string, user: User) {
    const project = await this.projectRepository.findOne({ where: { id: projectId } });
    const checks: DeploymentReadinessCheck[] = [];

    if (!project || project.status === ProjectStatus.ARCHIVED) {
      return this.result([{ key: "project", label: "Project", status: "missing", blocking: true, message: "Project not found." }]);
    }

    const canManage =
      user.role === UserRole.ADMIN ||
      (user.role === UserRole.DEVELOPER && project.ownerUserId === user.id);
    const canView =
      canManage ||
      project.ownerUserId === user.id ||
      (user.role === UserRole.READONLY && project.visibility === ProjectVisibility.WORKSPACE);

    if (!canView) {
      checks.push({ key: "access", label: "Project access", status: "failed", blocking: true, message: "Insufficient permissions." });
      return this.result(checks);
    }

    checks.push({ key: "project", label: "Project", status: "passed", blocking: false, message: "Project exists." });
    checks.push(this.checkBoolean("repository", "GitHub repository", Boolean(project.repositoryUrl), "Repository is linked.", "Link a GitHub repository first."));
    checks.push(this.checkBoolean("target_branch", "Target branch", Boolean(project.targetBranch), "Target branch is selected.", "Select a target branch first."));

    const contract = await this.contractRepository.findOne({ where: { projectId: project.id } });
    checks.push(this.checkBoolean("deployment_contract", "Deployment contract", Boolean(contract), "Deployment contract exists.", "Run stack detection first."));
    checks.push(this.checkBoolean("deployability", "Deployability", Boolean(contract?.deployable), "Deployment contract is deployable.", contract?.blockers?.[0] || "Resolve deployment contract blockers first."));

    const preflight = await this.preflightRepository.findOne({ where: { projectId: project.id } });
    const preflightPassed = Boolean(
      preflight &&
        [PreflightValidationStatus.PASSED, PreflightValidationStatus.PASSED_WITH_WARNINGS].includes(
          preflight.validationStatus as PreflightValidationStatus
        ) && preflight.inputFingerprint === contract?.contractHash
    );
    checks.push(this.checkBoolean("preflight", "Pre-flight validation", preflightPassed, "Pre-flight validation passed.", "Generate and pass pre-flight validation first."));

    const externalCiConfigured = Boolean(
      this.config.get<string>("GITHUB_APP_ID") &&
        this.config.get<string>("GITHUB_APP_PRIVATE_KEY") &&
        this.config.get<string>("GITHUB_ACTIONS_WORKFLOW_FILE", "deployguard.yml")
    );
    const isExternalCiRequired = externalCiRequired(this.config);
    checks.push({
      key: "external_ci_validation",
      label: "Optional External CI",
      status: externalCiConfigured ? "passed" : isExternalCiRequired ? "missing" : "warning",
      blocking: isExternalCiRequired && !externalCiConfigured,
      message: externalCiConfigured
        ? "Optional external CI dispatch is configured."
        : isExternalCiRequired
          ? "External CI is required but is not configured."
          : "External CI is not configured. DeployGuard internal pipeline remains available.",
    });

    const latestRun = await this.runRepository.findOne({
      where: { projectId: project.id },
      order: { createdAt: "DESC" },
    });
    const deploymentActivity = await this.pipelineActivity.inspect(project.id, latestRun);
    checks.push(this.checkBoolean("artifact", "Docker artifact", Boolean(!latestRun || latestRun.ecrImageUri || canManage), "Docker build artifact is ready or can be built by deployment.", "Docker build artifact is not ready."));

    const latestCost = await this.costEstimateRepository.findOne({
      where: { projectId: project.id },
      order: { createdAt: "DESC" },
    });
    checks.push(this.costCheck(latestCost));

    checks.push(this.checkBoolean("aws_config", "AWS configuration", this.hasAwsConfig(), "AWS configuration is present.", "AWS credentials are not configured."));
    const infraConfig = getInfrastructureConfig(this.config);
    checks.push(this.checkBoolean("terraform_templates", "Terraform templates", existsSync(infraConfig.terraformNetworkTemplateDir), "Terraform templates are configured.", "Terraform templates are not configured."));

    const activeEnvironment = await this.environmentRepository.findOne({
      where: [
        { projectId: project.id, status: InfrastructureEnvironmentStatus.QUEUED },
        { projectId: project.id, status: InfrastructureEnvironmentStatus.PLANNING },
        { projectId: project.id, status: InfrastructureEnvironmentStatus.PROVISIONING },
      ],
      order: { createdAt: "DESC" },
    });
    checks.push(this.checkBoolean(
      "not_in_progress",
      "Deployment progress",
      !activeEnvironment && !deploymentActivity.isDeploymentJobActive,
      "No deployment is currently running.",
      "Deployment already in progress.",
    ));
    checks.push(this.checkBoolean("write_access", "Deploy permission", canManage, "User can deploy this project.", "Readonly users cannot deploy."));

    return this.result(checks);
  }

  async assertDeploymentReady(projectId: string, user: User) {
    const readiness = await this.getDeploymentReadiness(projectId, user);

    if (!readiness.ready) {
      throw new Error(readiness.blockingReasons[0] || "Deployment is not ready.");
    }

    return readiness;
  }

  async getReadinessReasons(projectId: string, user: User) {
    const readiness = await this.getDeploymentReadiness(projectId, user);
    return readiness.blockingReasons;
  }

  private result(checks: DeploymentReadinessCheck[]) {
    const blockingReasons = checks
      .filter((check) => check.blocking)
      .map((check) => check.message);

    return {
      ready: blockingReasons.length === 0,
      checks,
      blockingReasons,
      nextRequiredAction: blockingReasons[0] || null,
    };
  }

  private checkBoolean(
    key: string,
    label: string,
    passed: boolean,
    passedMessage: string,
    failedMessage: string
  ): DeploymentReadinessCheck {
    return {
      key,
      label,
      status: passed ? "passed" : "missing",
      blocking: !passed,
      message: passed ? passedMessage : failedMessage,
    };
  }

  private costCheck(estimate: ProjectCostEstimate | null): DeploymentReadinessCheck {
    const finops = getFinopsConfig(this.config);
    if (finops.mockMode || !finops.infracostEnabled) {
      return { key: "cost", label: "FinOps cost gate", status: "warning", blocking: false, message: estimate ? "Only a mock/local estimate is available; no real Infracost result is claimed." : "FinOps/Infracost is disabled or mock and will not block deployment." };
    }
    if (!estimate) {
      return { key: "cost", label: "FinOps cost gate", status: "missing", blocking: true, message: "Generate a cost estimate first." };
    }

    const tierEnforcement = getFinopsConfig(this.config).enforceTierLimits;
    if (
      [CostEstimateStatus.NO_APPROVAL_REQUIRED, CostEstimateStatus.APPROVED, CostEstimateStatus.WARNING_OVER_TIER].includes(estimate.status) ||
      (!tierEnforcement && estimate.status === CostEstimateStatus.BLOCKED_BY_TIER_LIMIT)
    ) {
      if (estimate.status === CostEstimateStatus.WARNING_OVER_TIER || estimate.status === CostEstimateStatus.BLOCKED_BY_TIER_LIMIT) {
        return { key: "cost", label: "FinOps cost gate", status: "warning", blocking: false, message: "Estimate is over tier, but tier enforcement is off." };
      }
      return { key: "cost", label: "FinOps cost gate", status: "passed", blocking: false, message: "Cost gate passed." };
    }

    const messages: Record<string, string> = {
      [CostEstimateStatus.APPROVAL_REQUIRED]: "Cost approval is required before deployment.",
      [CostEstimateStatus.REJECTED]: "Cost estimate was rejected.",
      [CostEstimateStatus.BLOCKED_BY_TIER_LIMIT]: "Deployment blocked by subscription tier limit.",
      [CostEstimateStatus.FAILED]: "Cost analysis failed.",
    };

    return {
      key: "cost",
      label: "FinOps cost gate",
      status: "failed",
      blocking: true,
      message: messages[estimate.status] || "Cost gate is not ready.",
    };
  }

  private hasAwsConfig() {
    return Boolean(
      this.config.get<string>("AWS_REGION") &&
        this.config.get<string>("AWS_ACCOUNT_ID") &&
        this.config.get<string>("AWS_ACCESS_KEY_ID") &&
        this.config.get<string>("AWS_SECRET_ACCESS_KEY")
    );
  }
}
