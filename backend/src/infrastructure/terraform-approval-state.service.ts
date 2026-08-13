import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Repository } from "typeorm";
import { ProjectConfigurationSnapshot } from "../projects/project-configuration-snapshot.entity";
import { ProjectPipelineEvent } from "../projects/project-pipeline-event.entity";
import { PipelineRunStatus, ProjectPipelineRun } from "../projects/project-pipeline-run.entity";
import { isPipelineFailed } from "../projects/pipeline/pipeline-status";
import { DatabaseServiceBindingService } from "./database-service-binding.service";
import { ProjectInfrastructureEnvironment } from "./project-infrastructure-environment.entity";

export type TerraformApprovalBlockedReason =
  | "run_not_found"
  | "run_superseded"
  | "plan_missing"
  | "plan_stale"
  | "configuration_changed"
  | "already_approved"
  | "run_failed"
  | "not_at_apply_gate";

export type TerraformApprovalState = {
  runId: string | null;
  required: boolean;
  eligible: boolean;
  blockedReason: TerraformApprovalBlockedReason | null;
  blockedMessage: string | null;
  planFingerprint: string | null;
  configurationFingerprint: string | null;
  contractFingerprint: string | null;
  terraformInputFingerprint: string | null;
  planGeneratedAt: string | null;
  planExpiresAt: string | null;
};

export const TERRAFORM_APPROVAL_MESSAGES: Record<TerraformApprovalBlockedReason, string> = {
  run_not_found: "The deployment run no longer exists.",
  run_superseded: "A newer deployment run superseded this Terraform plan.",
  plan_missing: "The reviewed Terraform plan is unavailable. Regenerate the plan before approval.",
  plan_stale: "The reviewed Terraform plan is stale. Regenerate it before approval.",
  configuration_changed: "Project configuration changed after planning. Regenerate the Terraform plan before approval.",
  already_approved: "Terraform approval was already consumed for this run.",
  run_failed: "This deployment run has already failed and cannot consume Terraform approval.",
  not_at_apply_gate: "This deployment has not reached the Terraform apply approval gate.",
};

type EvaluateOptions = {
  events?: ProjectPipelineEvent[];
  environment?: ProjectInfrastructureEnvironment | null;
};

@Injectable()
export class TerraformApprovalStateService {
  constructor(
    @InjectRepository(ProjectPipelineRun) private readonly runs: Repository<ProjectPipelineRun>,
    @InjectRepository(ProjectPipelineEvent) private readonly events: Repository<ProjectPipelineEvent>,
    @InjectRepository(ProjectInfrastructureEnvironment) private readonly environments: Repository<ProjectInfrastructureEnvironment>,
    @InjectRepository(ProjectConfigurationSnapshot) private readonly snapshots: Repository<ProjectConfigurationSnapshot>,
    private readonly effectiveConfiguration: DatabaseServiceBindingService,
  ) {}

  async evaluate(projectId: string, run: ProjectPipelineRun | null, options: EvaluateOptions = {}): Promise<TerraformApprovalState> {
    if (!run) return this.blocked(null, false, "run_not_found");
    const latest = await this.runs.findOne({ where: { projectId }, order: { createdAt: "DESC" } });
    if (!latest || latest.id !== run.id) return this.blocked(run.id, false, "run_superseded");

    const metadata = (run.metadata || {}) as Record<string, unknown>;
    if (isPipelineFailed(run.status) || run.failedAt) return this.blocked(run.id, false, "run_failed");
    if (metadata.applyApprovedAt) return this.blocked(run.id, false, "already_approved");

    const events = options.events || await this.events.find({
      where: { projectId, pipelineRunId: run.id },
      order: { occurredAt: "ASC", sequenceNumber: "ASC" },
    });
    const latestApprovalEvent = [...events].reverse().find((event) =>
      ["terraform_apply_approval_required", "terraform_apply_approval_queued", "terraform_apply_gate_passed"].includes(event.stage)
      || (event.stage.startsWith("terraform_apply_approval") && event.status === "failed")
    );
    const pausedAtGate = run.status === PipelineRunStatus.APPLY_DISABLED
      && run.currentStage === "terraform_apply_approval_required"
      && latestApprovalEvent?.stage === "terraform_apply_approval_required";
    if (!pausedAtGate) return this.blocked(run.id, false, "not_at_apply_gate");

    const environment = options.environment || await this.environments.findOne({
      where: { projectId, pipelineRunId: run.id },
      order: { updatedAt: "DESC" },
    });
    if (!environment?.terraformPlanSummary || !environment.terraformWorkspacePath) {
      return this.blocked(run.id, true, "plan_missing");
    }
    const plan = (environment.metadata || {}) as Record<string, unknown>;
    const planFingerprint = this.string(plan.planFingerprint);
    const artifactSha256 = this.string(plan.planArtifactSha256);
    const planConfigurationFingerprint = this.string(plan.planConfigurationFingerprint);
    const contractFingerprint = this.string(plan.contractFingerprint);
    const terraformInputFingerprint = this.string(plan.terraformInputFingerprint);
    const generatedAt = this.string(plan.planGeneratedAt);
    const expiresAt = this.string(plan.planExpiresAt);
    if (!planFingerprint || !artifactSha256 || !planConfigurationFingerprint || !contractFingerprint || !terraformInputFingerprint || !generatedAt || !expiresAt) {
      return this.blocked(run.id, true, "plan_stale", planFingerprint, planConfigurationFingerprint, generatedAt, expiresAt, contractFingerprint, terraformInputFingerprint);
    }
    if (new Date(expiresAt).getTime() <= Date.now()) {
      return this.blocked(run.id, true, "plan_stale", planFingerprint, planConfigurationFingerprint, generatedAt, expiresAt, contractFingerprint, terraformInputFingerprint);
    }

    const snapshot = await this.snapshots.findOne({ where: { projectId, pipelineRunId: run.id } });
    if (!snapshot || snapshot.id !== run.configurationSnapshotId || snapshot.configurationFingerprint !== planConfigurationFingerprint) {
      return this.blocked(run.id, true, "configuration_changed", planFingerprint, planConfigurationFingerprint, generatedAt, expiresAt, contractFingerprint, terraformInputFingerprint);
    }
    try {
      await this.effectiveConfiguration.assertRunConfigurationCurrent(projectId, run.id);
    } catch {
      return this.blocked(run.id, true, "configuration_changed", planFingerprint, planConfigurationFingerprint, generatedAt, expiresAt, contractFingerprint, terraformInputFingerprint);
    }

    try {
      const artifact = await readFile(join(environment.terraformWorkspacePath, "tfplan"));
      const currentArtifactSha256 = createHash("sha256").update(artifact).digest("hex");
      const expectedFingerprint = this.planFingerprint(currentArtifactSha256, terraformInputFingerprint, run.id, contractFingerprint);
      if (currentArtifactSha256 !== artifactSha256 || expectedFingerprint !== planFingerprint) {
        return this.blocked(run.id, true, "plan_stale", planFingerprint, planConfigurationFingerprint, generatedAt, expiresAt, contractFingerprint, terraformInputFingerprint);
      }
    } catch {
      return this.blocked(run.id, true, "plan_missing", planFingerprint, planConfigurationFingerprint, generatedAt, expiresAt, contractFingerprint, terraformInputFingerprint);
    }

    return {
      runId: run.id,
      required: true,
      eligible: true,
      blockedReason: null,
      blockedMessage: null,
      planFingerprint,
      configurationFingerprint: planConfigurationFingerprint,
      contractFingerprint,
      terraformInputFingerprint,
      planGeneratedAt: generatedAt,
      planExpiresAt: expiresAt,
    };
  }

  planFingerprint(artifactSha256: string, terraformInputFingerprint: string, runId: string, contractFingerprint = terraformInputFingerprint) {
    return createHash("sha256").update(JSON.stringify({ artifactSha256, contractFingerprint, runId, terraformInputFingerprint })).digest("hex");
  }

  private blocked(
    runId: string | null,
    required: boolean,
    reason: TerraformApprovalBlockedReason,
    planFingerprint: string | null = null,
    configurationFingerprint: string | null = null,
    planGeneratedAt: string | null = null,
    planExpiresAt: string | null = null,
    contractFingerprint: string | null = null,
    terraformInputFingerprint: string | null = null,
  ): TerraformApprovalState {
    return {
      runId,
      required,
      eligible: false,
      blockedReason: reason,
      blockedMessage: TERRAFORM_APPROVAL_MESSAGES[reason],
      planFingerprint,
      configurationFingerprint,
      contractFingerprint,
      terraformInputFingerprint,
      planGeneratedAt,
      planExpiresAt,
    };
  }

  private string(value: unknown) {
    return typeof value === "string" && value.trim() ? value : null;
  }
}
