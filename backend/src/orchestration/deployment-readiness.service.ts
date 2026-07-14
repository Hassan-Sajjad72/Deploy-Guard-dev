import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { CostEstimateStatus, ProjectCostEstimate } from "../finops/project-cost-estimate.entity";
import { InfrastructureEnvironmentStatus, ProjectInfrastructureEnvironment } from "../infrastructure/project-infrastructure-environment.entity";
import { ProjectPipelineRun } from "../projects/project-pipeline-run.entity";
import { ProjectSecurityScan, SecurityPolicyDecision } from "../projects/project-security-scan.entity";
import { ProjectTerraformState, TerraformStateStatus } from "../state-management/project-terraform-state.entity";
import { ProjectPersistentStorage } from "../storage/project-persistent-storage.entity";

@Injectable()
export class OrchestrationDeploymentReadinessService {
  constructor(
    @InjectRepository(ProjectCostEstimate)
    private readonly costRepository: Repository<ProjectCostEstimate>,
    @InjectRepository(ProjectInfrastructureEnvironment)
    private readonly environmentRepository: Repository<ProjectInfrastructureEnvironment>,
    @InjectRepository(ProjectSecurityScan)
    private readonly scanRepository: Repository<ProjectSecurityScan>,
    @InjectRepository(ProjectTerraformState)
    private readonly stateRepository: Repository<ProjectTerraformState>,
    @InjectRepository(ProjectPersistentStorage)
    private readonly storageRepository: Repository<ProjectPersistentStorage>
  ) {}

  isReadyForEcsDeployment(run: ProjectPipelineRun) {
    return Boolean(run.ecrImageUri && run.commitSha && /^[0-9a-f]{40}$/i.test(run.commitSha));
  }

  verifyEcrImageExists(run: ProjectPipelineRun) {
    return {
      passed: this.isReadyForEcsDeployment(run),
      reason: this.isReadyForEcsDeployment(run)
        ? null
        : "ECR image URI and full commit SHA are required before ECS deployment.",
    };
  }

  async verifyInfrastructureProvisioned(projectId: string) {
    const environment = await this.environmentRepository.findOne({
      where: { projectId },
      order: { createdAt: "DESC" },
    });
    const passed = environment?.status === InfrastructureEnvironmentStatus.PROVISIONED;

    return {
      passed,
      reason: passed ? null : "Infrastructure must be provisioned before ECS deployment.",
      environment,
    };
  }

  async verifyCostGatePassed(projectId: string) {
    const estimate = await this.costRepository.findOne({
      where: { projectId },
      order: { createdAt: "DESC" },
    });
    const passed = Boolean(
      estimate &&
        [CostEstimateStatus.NO_APPROVAL_REQUIRED, CostEstimateStatus.APPROVED].includes(
          estimate.status
        )
    );

    return {
      passed,
      reason: passed ? null : "FinOps cost gate must pass before ECS deployment.",
      estimate,
    };
  }

  async verifySecurityGatePassed(projectId: string, pipelineRunId?: string | null) {
    const scan = await this.scanRepository.findOne({
      where: pipelineRunId ? { projectId, pipelineRunId } : { projectId },
      order: { createdAt: "DESC" },
    });
    const passed = Boolean(
      scan &&
        [SecurityPolicyDecision.ALLOWED, SecurityPolicyDecision.APPROVED_OVERRIDE].includes(
          scan.policyDecision as SecurityPolicyDecision
        )
    );

    return {
      passed,
      reason: passed ? null : "Security scan gate must pass before ECS deployment.",
      scan,
    };
  }

  async verifyStateLockSafe(projectId: string) {
    const state = await this.stateRepository.findOne({
      where: { projectId },
      order: { createdAt: "DESC" },
    });
    const passed = !state || [TerraformStateStatus.ACTIVE, TerraformStateStatus.RECOVERED].includes(state.status as TerraformStateStatus);

    return {
      passed,
      reason: passed ? null : "Terraform state must be active or recovered before ECS deployment.",
      state,
    };
  }

  async verifyEfsMountConfigIfNeeded(projectId: string) {
    const storage = await this.storageRepository.findOne({
      where: { projectId, environmentName: "dev" },
      order: { createdAt: "DESC" },
    });
    const needed = Boolean(storage?.enabled);
    const passed = !needed || Boolean(storage?.efsFileSystemId && storage?.efsAccessPointId);

    return {
      passed,
      reason: passed ? null : "Enabled EFS storage must have filesystem and access point outputs before ECS deployment.",
      storage,
    };
  }

  async getBlockingReasons(run: ProjectPipelineRun) {
    const checks = [
      this.verifyEcrImageExists(run),
      await this.verifyInfrastructureProvisioned(run.projectId),
      await this.verifyCostGatePassed(run.projectId),
      await this.verifySecurityGatePassed(run.projectId, run.id),
      await this.verifyStateLockSafe(run.projectId),
      await this.verifyEfsMountConfigIfNeeded(run.projectId),
    ];

    return checks
      .filter((check) => !check.passed)
      .map((check) => check.reason)
      .filter(Boolean);
  }
}
