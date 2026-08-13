import { Injectable } from "@nestjs/common";
import { ProjectPipelineEvent } from "../project-pipeline-event.entity";
import { PipelineRunStatus, ProjectPipelineRun } from "../project-pipeline-run.entity";
import { isPipelineInProgress } from "../pipeline/pipeline-status";
import { PipelineStageStatus, ResolvedPipelineStage } from "./project-current-state.types";
import {
  matchesPipelineStage,
  PIPELINE_LIFECYCLE_REGISTRY,
  PIPELINE_STAGE_REGISTRY,
  PipelineStageDefinition,
  pipelineStageDefinition,
} from "../pipeline/pipeline-stage-registry";
import { ResolvedLifecycleStage } from "./project-current-state.types";

type ResolveInput = {
  run: ProjectPipelineRun | null;
  events: ProjectPipelineEvent[];
  applyEnabled: boolean;
  githubActionsRequired: boolean;
  hasRuntimeSignals: boolean;
  hasDeployment: boolean;
  hasStableRelease: boolean;
  costTierWarningOnly: boolean;
};

@Injectable()
export class PipelineStageResolverService {
  resolve(input: ResolveInput): ResolvedPipelineStage[] {
    const stages = PIPELINE_STAGE_REGISTRY.map((definition) => {
      if (definition.key === "external_ci_validation") {
        return this.resolveExternalCi(input);
      }
      if (!input.run) return this.emptyStage(definition);
      const events = input.events.filter((event) => matchesPipelineStage(definition, normalize(event.stage)));
      return this.resolveEvents(definition, events, input.run);
    });

    this.applyKnownState(stages, input);
    this.flagStagesMissingCompletionEvidence(stages);
    const externalCi = stageByName(stages, "external_ci_validation");
    if (externalCi.required && externalCi.status === "failed") {
      this.blockAfterExternalCi(stages, externalCi);
    }
    this.blockDownstreamStages(stages);

    const observability = stageByName(stages, "observability");
    if (input.hasRuntimeSignals) {
      observability.status = "passed";
      observability.message = "Real runtime metrics are available.";
    } else {
      observability.status = "unavailable";
      observability.message = input.hasDeployment
        ? "Runtime observability is unavailable until deployment signals arrive."
        : "Runtime observability is unavailable until a real ECS deployment exists.";
      observability.blockedByStage = null;
      observability.blockedReason = null;
      observability.error = null;
    }
    return stages;
  }

  private flagStagesMissingCompletionEvidence(stages: ResolvedPipelineStage[]) {
    for (let index = 0; index < stages.length; index += 1) {
      const stage = stages[index];
      if (stage.status !== "running") continue;
      const downstreamReached = stages.slice(index + 1).some((later) =>
        ["passed", "running", "failed", "requires_approval"].includes(later.status)
      );
      if (!downstreamReached) continue;
      stage.status = "warning";
      stage.endedAt = null;
      stage.error = null;
      stage.canRetry = false;
      stage.message = "A downstream stage ran, but this stage has no explicit success event.";
    }
  }

  resolveLifecycle(stages: ResolvedPipelineStage[]): ResolvedLifecycleStage[] {
    return PIPELINE_LIFECYCLE_REGISTRY.map((lifecycle) => {
      const matching = stages.filter((stage) => pipelineStageDefinition(stage.stage)?.lifecycleKey === lifecycle.key);
      const required = matching.some((stage) => stage.required);
      const strongest = [...matching].sort((left, right) => statusRank(right.status) - statusRank(left.status))[0];
      const startedAt = matching.map((stage) => stage.startedAt).filter(Boolean).sort((a, b) => new Date(a!).getTime() - new Date(b!).getTime())[0] || null;
      const endedAt = matching.map((stage) => stage.endedAt).filter(Boolean).sort((a, b) => new Date(a!).getTime() - new Date(b!).getTime()).at(-1) || null;
      const status = strongest?.status || "not_started";
      return {
        ...(strongest || this.emptyLifecycleStage(lifecycle.key, lifecycle.label)),
        stage: lifecycle.key,
        label: lifecycle.label,
        order: lifecycle.order,
        status,
        required,
        canSkip: !required,
        startedAt,
        endedAt,
        durationMs: startedAt && endedAt ? Math.max(0, new Date(endedAt).getTime() - new Date(startedAt).getTime()) : null,
        technicalStages: matching.map((stage) => stage.stage),
      } as ResolvedLifecycleStage;
    });
  }

  resolveExternalCi(input: ResolveInput): ResolvedPipelineStage {
    const required = input.githubActionsRequired;
    const registryDefinition = pipelineStageDefinition("external_ci_validation")!;
    const definition = { ...registryDefinition, required };
    if (!input.run) return this.emptyStage(definition);

    const events = input.events.filter((event) => matchesPipelineStage(definition, normalize(event.stage)));
    if (!events.length) {
      return {
        ...this.emptyStage(definition),
        status: required && isPipelineInProgress(input.run.status) ? "pending" : required ? "not_started" : "skipped",
        message: required
          ? "Required external CI validation has not run yet."
          : "External CI is optional and was intentionally omitted.",
      };
    }

    const first = events[0];
    const terminal = events[events.length - 1];
    const rawStatus = normalize(terminal.status);
    let status: PipelineStageStatus = rawStatus === "success" ? "passed" : rawStatus as PipelineStageStatus;
    if (!required && status === "failed") status = "warning";
    const metadata = (terminal.metadata || {}) as Record<string, unknown>;

    return {
      stage: definition.key,
      label: definition.label,
      status,
      required,
      startedAt: first.createdAt || null,
      endedAt: ["passed", "failed", "warning", "skipped"].includes(status) ? terminal.createdAt || null : null,
      durationMs: first.createdAt && terminal.createdAt
        ? Math.max(0, new Date(terminal.createdAt).getTime() - new Date(first.createdAt).getTime())
        : null,
      message: terminal.message || "External CI status was recorded.",
      error: status === "failed" ? terminal.message : null,
      blockedByStage: null,
      blockedReason: null,
      canRetry: status === "failed" || status === "warning",
      canSkip: !required,
      source: definition.source,
      diagnosticCode: typeof metadata.diagnosticCode === "string" ? metadata.diagnosticCode : null,
    };
  }

  private resolveEvents(definition: PipelineStageDefinition, events: ProjectPipelineEvent[], run: ProjectPipelineRun): ResolvedPipelineStage {
    if (!events.length) {
      return {
        ...this.emptyStage(definition),
        status: isPipelineInProgress(run.status) ? "pending" : "not_started",
        message: isPipelineInProgress(run.status) ? "Queued behind earlier pipeline stages." : "This stage was not attempted in the latest run.",
      };
    }

    const first = events[0];
    const last = events[events.length - 1];
    let status: PipelineStageStatus = "not_started";
    let terminal = last;
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const candidate = events[index];
      if (candidate.status === "disabled_by_config") status = "disabled_by_config";
      else if (/approval_required/.test(candidate.stage) && ["waiting", "pending", "approval_required"].includes(candidate.status)) status = "requires_approval";
      else if (candidate.status === "failed") status = "failed";
      else if (candidate.status === "skipped" || candidate.metadata?.status === "reused") status = "skipped";
      else if (candidate.status === "success") status = "passed";
      else if (["running", "started"].includes(candidate.status)) status = "running";
      else if (["queued", "waiting", "pending"].includes(candidate.status)) status = "pending";
      else continue;
      terminal = candidate;
      break;
    }

    const startedAt = first.createdAt || null;
    const endedAt = ["passed", "failed", "skipped", "disabled_by_config"].includes(status) ? terminal.createdAt || null : null;
    const metadata = (terminal.metadata || {}) as Record<string, unknown>;
    return {
      stage: definition.key,
      label: definition.label,
      status,
      required: definition.required,
      startedAt,
      endedAt,
      durationMs: startedAt && endedAt ? Math.max(0, new Date(endedAt).getTime() - new Date(startedAt).getTime()) : null,
      message: terminal.message || "Stage status recorded by the pipeline.",
      error: status === "failed" ? terminal.message : null,
      blockedByStage: null,
      blockedReason: null,
      canRetry: status === "failed",
      canSkip: definition.canSkip,
      source: definition.source,
      diagnosticCode: typeof metadata.diagnosticCode === "string" ? metadata.diagnosticCode : null,
    };
  }

  private applyKnownState(stages: ResolvedPipelineStage[], input: ResolveInput) {
    const costGate = stageByName(stages, "cost_gate");
    if (input.costTierWarningOnly) {
      const estimate = stageByName(stages, "finops_estimate");
      estimate.status = "passed";
      estimate.error = null;
      estimate.message = "Cost estimate completed; tier enforcement is off.";
      costGate.status = "passed";
      costGate.error = null;
      costGate.message = "Tier overage is a warning because tier enforcement is off.";
    }
    if (input.run?.status === PipelineRunStatus.WAITING_FOR_COST_APPROVAL) {
      costGate.status = "requires_approval";
      costGate.message = "Cost approval is required before deployment can continue.";
    }

    if (input.run?.status === PipelineRunStatus.WAITING_FOR_STATE_LOCK) {
      const applyLock = input.events.some((event) => /apply/.test(String(event.metadata?.operation || event.stage)));
      const lockStage = stageByName(stages, applyLock ? "terraform_apply" : "terraform_plan");
      lockStage.status = "pending";
      lockStage.message = `Waiting for the Terraform state lock before ${applyLock ? "apply" : "plan"}.`;
    }

    const applyGate = stageByName(stages, "terraform_apply_gate");
    const earlierBlocker = stages.slice(0, stages.indexOf(applyGate)).some((stage) => stage.required && ["failed", "requires_approval", "disabled_by_config"].includes(stage.status));
    const reachedApplyGate = input.events.some((event) =>
      [
        "terraform_apply_gate_passed",
        "terraform_apply_approval_required",
        "terraform_apply_approval_queued",
        "terraform_apply_gate_disabled_by_config",
        "infrastructure_apply_disabled_by_config",
        "infrastructure_apply_started",
        "infrastructure_apply_completed",
      ].includes(normalize(event.stage))
    );
    if (!input.applyEnabled && !earlierBlocker && reachedApplyGate) {
      applyGate.status = "disabled_by_config";
      applyGate.message = "Terraform apply is disabled by TERRAFORM_APPLY_ENABLED=false.";
      applyGate.error = null;
      applyGate.canRetry = false;
    }

    const stable = stageByName(stages, "stable_release");
    if (input.hasStableRelease && stable.status === "not_started") {
      stable.status = "passed";
      stable.message = "A stable release is recorded for this project.";
    }
  }

  private blockAfterExternalCi(stages: ResolvedPipelineStage[], externalCi: ResolvedPipelineStage) {
    for (const stage of stages.slice(1)) {
      if (!["not_started", "pending"].includes(stage.status)) continue;
      stage.status = "blocked";
      stage.blockedByStage = externalCi.stage;
      stage.blockedReason = externalCi.message;
      stage.message = "Blocked by required External CI Validation.";
    }
  }

  private blockDownstreamStages(stages: ResolvedPipelineStage[]) {
    let blocker: ResolvedPipelineStage | null = null;
    for (const stage of stages) {
      if (blocker) {
        stage.status = "blocked";
        stage.blockedByStage = blocker.stage;
        stage.blockedReason = blocker.message;
        stage.message = blocker.stage === "terraform_apply_gate" ? "Blocked at Terraform Apply Gate." : `Blocked by ${blocker.label}.`;
        stage.startedAt = null;
        stage.endedAt = null;
        stage.durationMs = null;
        stage.error = null;
        stage.canRetry = false;
      }
      if (!blocker && stage.required && ["failed", "requires_approval", "disabled_by_config"].includes(stage.status)) blocker = stage;
    }
  }

  private emptyStage(definition: PipelineStageDefinition): ResolvedPipelineStage {
    return {
      stage: definition.key,
      label: definition.label,
      status: "not_started",
      required: definition.required,
      startedAt: null,
      endedAt: null,
      durationMs: null,
      message: "This stage has not been requested.",
      error: null,
      blockedByStage: null,
      blockedReason: null,
      canRetry: false,
      canSkip: definition.canSkip,
      source: definition.source,
      diagnosticCode: null,
    };
  }

  private emptyLifecycleStage(stage: string, label: string): ResolvedPipelineStage {
    return {
      stage,
      label,
      status: "not_started",
      required: false,
      startedAt: null,
      endedAt: null,
      durationMs: null,
      message: "This stage has not been reached.",
      error: null,
      blockedByStage: null,
      blockedReason: null,
      canRetry: false,
      canSkip: true,
      source: "pipeline",
      diagnosticCode: null,
    };
  }
}

function normalize(value: unknown) {
  return String(value || "").toLowerCase();
}

function stageByName(stages: ResolvedPipelineStage[], name: string) {
  return stages.find((stage) => stage.stage === name)!;
}

function statusRank(status: PipelineStageStatus) {
  return {
    failed: 100,
    requires_approval: 95,
    blocked: 90,
    disabled_by_config: 80,
    running: 70,
    pending: 60,
    warning: 50,
    passed: 40,
    skipped: 30,
    not_started: 20,
    unavailable: 10,
  }[status] || 0;
}
