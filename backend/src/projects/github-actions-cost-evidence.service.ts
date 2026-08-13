import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectRepository } from "@nestjs/typeorm";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Repository } from "typeorm";
import { CostEstimateSource, CostEstimateStatus, ProjectCostEstimate } from "../finops/project-cost-estimate.entity";
import { InfracostService } from "../finops/infracost.service";
import { GithubActionsService } from "./pipeline/github-actions.service";
import { ProjectPipelineRun } from "./project-pipeline-run.entity";

@Injectable()
export class GithubActionsCostEvidenceService {
  private readonly logger = new Logger(GithubActionsCostEvidenceService.name);
  constructor(
    @InjectRepository(ProjectCostEstimate) private readonly estimates: Repository<ProjectCostEstimate>,
    private readonly actions: GithubActionsService,
    private readonly infracost: InfracostService,
    private readonly config: ConfigService,
  ) {}

  async capture(operation: ProjectPipelineRun, repository: string, token: string, environmentName: string) {
    const candidateWorkflowRunId = String(operation.metadata?.candidateWorkflowRunId || operation.githubWorkflowRunId || "").trim();
    if (!this.config.get<string>("INFRACOST_API_KEY", "").trim() || !candidateWorkflowRunId || !operation.generationId || operation.metadata?.deploymentAction !== "deploy") return null;
    const existing = await this.estimates.findOne({ where: { pipelineRunId: operation.id } });
    if (existing?.source === CostEstimateSource.INFRACOST && existing.status !== CostEstimateStatus.FAILED) return existing;
    const directory = await mkdtemp(join(tmpdir(), "deployguard-infracost-evidence-"));
    let estimate = existing || this.estimates.create({
      projectId: operation.projectId,
      generationId: operation.generationId,
      environmentName,
      pipelineRunId: operation.id,
      createdByUserId: operation.triggeredByUserId,
      status: CostEstimateStatus.CALCULATING,
      source: CostEstimateSource.INFRACOST,
      currency: "USD",
      totalMonthlyCost: 0,
      previousMonthlyCost: 0,
      monthlyCostDifference: 0,
      subscriptionTier: "operation_evidence",
      approvalRequired: false,
      blockedByTierLimit: false,
      metadata: { evidenceContract: "deployguard.infracost-operation/v1" },
    });
    estimate = await this.estimates.save(estimate);
    try {
      const [generationPlan, projectPlan] = await Promise.all([
        this.actions.getArtifactEntry(repository, candidateWorkflowRunId, operation.id, token, "terraform/deployguard-cost-plan.json", 10 * 1024 * 1024),
        this.actions.getArtifactEntry(repository, candidateWorkflowRunId, operation.id, token, "project-terraform/deployguard-project-cost-plan.json", 10 * 1024 * 1024),
      ]);
      if (!generationPlan) throw new Error("The immutable generation Terraform cost-plan artifact is unavailable.");
      const plans = [
        { scope: "generation", plan: generationPlan },
        ...(projectPlan ? [{ scope: "project", plan: projectPlan }] : []),
      ];
      const results = [] as Array<{ scope: string; raw: Record<string, unknown> }>;
      const resources = [] as ReturnType<InfracostService["normalizeCostBreakdown"]>;
      for (const item of plans) {
        const raw = this.infracost.parseInfracostResponse(await this.infracost.runInfracostBreakdown(item.plan, directory));
        results.push({ scope: item.scope, raw });
        resources.push(...this.infracost.normalizeCostBreakdown(raw).map((resource) => ({
          ...resource,
          metadata: { ...(resource.metadata || {}), terraformScope: item.scope },
        })));
      }
      const total = resources.reduce((sum, resource) => sum + resource.monthlyCost, 0);
      estimate.status = CostEstimateStatus.NO_APPROVAL_REQUIRED;
      estimate.totalMonthlyCost = Math.round(total * 100) / 100;
      estimate.terraformPlanSummary = (operation.metadata?.terraformPlanSummary || null) as Record<string, unknown> | null;
      estimate.rawInfracostResponse = { plans: results };
      estimate.normalizedBreakdown = { resources };
      estimate.errorMessage = null;
      estimate.metadata = { evidenceContract: "deployguard.infracost-operation/v1", operationId: operation.id, generationId: operation.generationId, environmentName, candidateWorkflowRunId, terraformScopes: plans.map((item) => item.scope) };
      return await this.estimates.save(estimate);
    } catch (error) {
      estimate.status = CostEstimateStatus.FAILED;
      estimate.errorMessage = error instanceof Error ? error.message.slice(0, 500) : "Infracost operation evidence failed.";
      await this.estimates.save(estimate);
      this.logger.warn(`Infracost evidence failed for ${operation.id}: ${estimate.errorMessage}`);
      return estimate;
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}
