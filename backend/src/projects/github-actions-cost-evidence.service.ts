import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectRepository } from "@nestjs/typeorm";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Repository } from "typeorm";
import { CostEstimateSource, CostEstimateStatus, ProjectCostEstimate } from "../finops/project-cost-estimate.entity";
import { ProjectCostSettings } from "../finops/project-cost-settings.entity";
import { InfracostService } from "../finops/infracost.service";
import { NotificationDispatcherService } from "../notifications/notification-dispatcher.service";
import { ProjectStableRelease, StableReleaseStatus } from "../orchestration/project-stable-release.entity";
import { GithubActionsService } from "./pipeline/github-actions.service";
import { ProjectPipelineRun } from "./project-pipeline-run.entity";

@Injectable()
export class GithubActionsCostEvidenceService {
  private readonly logger = new Logger(GithubActionsCostEvidenceService.name);
  constructor(
    @InjectRepository(ProjectCostEstimate) private readonly estimates: Repository<ProjectCostEstimate>,
    @InjectRepository(ProjectCostSettings) private readonly settings: Repository<ProjectCostSettings>,
    @InjectRepository(ProjectStableRelease) private readonly releases: Repository<ProjectStableRelease>,
    private readonly actions: GithubActionsService,
    private readonly infracost: InfracostService,
    private readonly config: ConfigService,
    private readonly notifications: NotificationDispatcherService,
  ) {}

  async capture(operation: ProjectPipelineRun, repository: string, token: string, environmentName: string) {
    const candidateWorkflowRunId = String(operation.metadata?.candidateWorkflowRunId || operation.githubWorkflowRunId || "").trim();
    const deploymentAction = String(operation.metadata?.deploymentAction || "");
    if (!this.config.get<string>("INFRACOST_API_KEY", "").trim() || !candidateWorkflowRunId || !operation.generationId || !["deploy", "rollback"].includes(deploymentAction)) return null;
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
      let inheritedProjectEstimate: ProjectCostEstimate | null = null;
      if (deploymentAction === "rollback" && !projectPlan) {
        const previous = await this.estimates.find({
          where: { projectId: operation.projectId, environmentName, source: CostEstimateSource.INFRACOST },
          order: { updatedAt: "DESC" },
          take: 20,
        });
        inheritedProjectEstimate = previous.find((item) => item.pipelineRunId !== operation.id
          && item.status === CostEstimateStatus.NO_APPROVAL_REQUIRED
          && Array.isArray((item.normalizedBreakdown as { resources?: unknown[] } | null)?.resources)
          && ((item.normalizedBreakdown as { resources: Array<{ metadata?: Record<string, unknown> }> }).resources)
            .some((resource) => resource.metadata?.terraformScope === "project")) || null;
        if (inheritedProjectEstimate) {
          const inheritedResources = (inheritedProjectEstimate.normalizedBreakdown as { resources: ReturnType<InfracostService["normalizeCostBreakdown"]> }).resources
            .filter((resource) => resource.metadata?.terraformScope === "project")
            .map((resource) => ({
              ...resource,
              metadata: {
                ...(resource.metadata || {}),
                terraformScope: "project",
                inheritedFromEstimateId: inheritedProjectEstimate!.id,
                inheritedFromOperationId: inheritedProjectEstimate!.pipelineRunId,
                inheritanceReason: "rollback_preserves_project_persistence",
              },
            }));
          resources.push(...inheritedResources);
        }
      }
      const total = resources.reduce((sum, resource) => sum + resource.monthlyCost, 0);
      const release = await this.releases.findOne({
        where: {
          projectId: operation.projectId,
          environmentName,
          generationId: operation.generationId,
          deployedByPipelineRunId: operation.id,
          status: StableReleaseStatus.STABLE,
        },
      });
      estimate.status = CostEstimateStatus.NO_APPROVAL_REQUIRED;
      estimate.totalMonthlyCost = Math.round(total * 100) / 100;
      estimate.terraformPlanSummary = (operation.metadata?.terraformPlanSummary || null) as Record<string, unknown> | null;
      estimate.rawInfracostResponse = { plans: results };
      estimate.normalizedBreakdown = { resources };
      estimate.errorMessage = null;
      estimate.metadata = {
        evidenceContract: "deployguard.infracost-operation/v1",
        operationId: operation.id,
        generationId: operation.generationId,
        releaseId: release?.id || null,
        environmentName,
        deploymentAction,
        candidateWorkflowRunId,
        terraformScopes: ["generation", ...(projectPlan ? ["project"] : inheritedProjectEstimate ? ["project_inherited"] : [])],
        inheritedProjectEstimateId: inheritedProjectEstimate?.id || null,
      };
      const saved = await this.estimates.save(estimate);
      const thresholds = await this.settings.findOne({ where: { projectId: operation.projectId } });
      if (thresholds && saved.totalMonthlyCost > Number(thresholds.warningThresholdMonthlyCost)) {
        await this.notifications.dispatch({
          projectId: operation.projectId,
          pipelineRunId: operation.id,
          eventId: saved.id,
          stage: "cost_threshold_exceeded",
          status: "warning",
          message: `Estimated monthly cost ${saved.currency} ${saved.totalMonthlyCost.toFixed(2)} exceeds the configured ${saved.currency} ${Number(thresholds.warningThresholdMonthlyCost).toFixed(2)} threshold.`,
          action: deploymentAction,
          environmentName,
          generationId: operation.generationId,
          commitSha: operation.commitSha,
          projectUrl: `${this.config.get<string>("FRONTEND_URL", "http://localhost:5173").replace(/\/$/, "")}/projects/${operation.projectId}/infrastructure`,
        }).catch((error) => this.logger.warn(`Cost threshold notification failed for ${operation.id}: ${error instanceof Error ? error.message : "unknown error"}`));
      }
      return saved;
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
