import { Injectable } from "@nestjs/common";
import { ProjectPipelineEvent } from "../project-pipeline-event.entity";
import { PipelineRunStatus, ProjectPipelineRun } from "../project-pipeline-run.entity";
import { isPipelineInProgress } from "../pipeline/pipeline-status";
import { PipelineStageStatus, ResolvedPipelineStage } from "./project-current-state.types";

type StageDefinition = {
  stage: string;
  label: string;
  required: boolean;
  canSkip: boolean;
  source: string;
  matches: (eventStage: string) => boolean;
};

const STAGES: StageDefinition[] = [
  definition("validate_inputs", "Validate Inputs", true, false, "pipeline", ["queued", "preparing", "readiness_check"]),
  definition("clone_repository", "Clone Repository", true, false, "pipeline", ["cloning", "clone_repository"]),
  definition("stack_detection_snapshot", "Stack Detection Snapshot", true, false, "detection", ["stack_detection_snapshot"]),
  definition("template_generation", "Template Generation", true, false, "templates", ["template_generation", "dockerfile_generated", "dockerignore_generated"]),
  definition("docker_build", "Docker Build", true, false, "docker", ["building_image", "docker_build"]),
  definition("trivy_scan", "Checking Dockerfile", true, false, "dockerfile", ["dockerfile_check"]),
  definition("security_gate", "Advisory Vulnerability Review", false, true, "security", ["security_scan", "security_policy", "security_gate"]),
  definition("ecr_push", "ECR Push", true, false, "ecr", ["tagging_image", "ecr_"]),
  definition("terraform_plan", "Terraform Plan", true, true, "terraform", ["terraform_stage", "terraform_plan", "infrastructure_plan"]),
  definition("finops_estimate", "FinOps Estimate", true, false, "finops", ["cost_analysis", "cost_breakdown", "cost_policy"]),
  definition("cost_gate", "Cost Gate", true, false, "finops", ["cost_approval", "cost_threshold", "deployment_blocked_by_cost", "cost_approved", "cost_analysis_passed"]),
  definition("terraform_apply_gate", "Terraform Apply Gate", true, false, "configuration", ["terraform_apply_gate", "infrastructure_apply_disabled_by_config"]),
  definition("state_lock", "State Lock", true, false, "state", ["state_lock", "state_heartbeat", "state_backend", "state_validation"]),
  definition("terraform_apply", "Terraform Apply", true, false, "terraform", ["infrastructure_apply_started", "infrastructure_apply_completed", "terraform_apply_started", "terraform_apply_completed"]),
  definition("efs", "Persistent Storage / EFS", false, true, "storage", ["storage_", "persistent_storage", "efs_", "backup_plan"]),
  definition("ecs_deploy", "ECS Deploy", true, false, "orchestration", ["ecs_cluster", "ecs_task", "ecs_service", "fargate_spot", "autoscaling", "spot_interruption"]),
  definition("alb_health", "ALB Health", true, false, "orchestration", ["alb_"]),
  definition("stable_release", "Stable Release", true, false, "orchestration", ["stable_release", "deployment_completed"]),
  definition("observability", "Observability", false, true, "observability", ["observability"]),
];

const EXTERNAL_CI: StageDefinition = definition(
  "external_ci_validation",
  "Optional External CI",
  false,
  true,
  "github_actions",
  ["external_ci_validation", "github_actions"]
);

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
    const stages = STAGES.map((definition) => {
      if (!input.run) return this.emptyStage(definition);
      const events = input.events.filter((event) => definition.matches(normalize(event.stage)));
      return this.resolveEvents(definition, events, input.run);
    });

    this.applyKnownState(stages, input);
    const externalCi = this.resolveExternalCi(input);
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

  resolveExternalCi(input: ResolveInput): ResolvedPipelineStage {
    const required = input.githubActionsRequired;
    const definition = { ...EXTERNAL_CI, required };
    if (!input.run) return this.emptyStage(definition);

    const events = input.events.filter((event) => definition.matches(normalize(event.stage)));
    if (!events.length) {
      return {
        ...this.emptyStage(definition),
        status: required && isPipelineInProgress(input.run.status) ? "pending" : "not_started",
        message: required
          ? "Required external CI validation has not run yet."
          : "External CI is optional and has not been requested.",
      };
    }

    const first = events[0];
    const terminal = events[events.length - 1];
    const rawStatus = normalize(terminal.status);
    let status: PipelineStageStatus = rawStatus === "success" ? "passed" : rawStatus as PipelineStageStatus;
    if (!required && status === "failed") status = "warning";
    const metadata = (terminal.metadata || {}) as Record<string, unknown>;

    return {
      stage: definition.stage,
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

  private resolveEvents(definition: StageDefinition, events: ProjectPipelineEvent[], run: ProjectPipelineRun): ResolvedPipelineStage {
    if (!events.length) {
      return {
        ...this.emptyStage(definition),
        status: isPipelineInProgress(run.status) ? "pending" : "not_started",
        message: isPipelineInProgress(run.status) ? "Queued behind earlier pipeline stages." : "This stage was not attempted in the latest run.",
      };
    }

    const first = events[0];
    const last = events[events.length - 1];
    const failed = [...events].reverse().find((event) => event.status === "failed");
    const disabled = [...events].reverse().find((event) => event.status === "disabled_by_config");
    const approval = [...events].reverse().find((event) => /approval_required/.test(event.stage));
    const skipped = [...events].reverse().find((event) => event.status === "skipped");
    const running = [...events].reverse().find((event) => ["running", "started"].includes(event.status));
    const queued = [...events].reverse().find((event) => ["queued", "waiting", "pending"].includes(event.status));
    const succeeded = [...events].reverse().find((event) => event.status === "success");
    let status: PipelineStageStatus = "not_started";
    let terminal = last;

    if (disabled) { status = "disabled_by_config"; terminal = disabled; }
    else if (approval) { status = "requires_approval"; terminal = approval; }
    else if (failed) { status = "failed"; terminal = failed; }
    else if (skipped) { status = "skipped"; terminal = skipped; }
    else if (succeeded && events.indexOf(succeeded) >= events.indexOf(running || first)) { status = "passed"; terminal = succeeded; }
    else if (running) { status = "running"; terminal = running; }
    else if (queued) { status = "pending"; terminal = queued; }

    const startedAt = first.createdAt || null;
    const endedAt = ["passed", "failed", "skipped", "disabled_by_config"].includes(status) ? terminal.createdAt || null : null;
    const metadata = (terminal.metadata || {}) as Record<string, unknown>;
    return {
      stage: definition.stage,
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

    const stateLock = stageByName(stages, "state_lock");
    if (input.run?.status === PipelineRunStatus.WAITING_FOR_STATE_LOCK) {
      stateLock.status = "pending";
      stateLock.message = "Waiting for the active Terraform state lock to be released.";
    }

    const applyGate = stageByName(stages, "terraform_apply_gate");
    const earlierBlocker = stages.slice(0, stages.indexOf(applyGate)).some((stage) => stage.required && ["failed", "requires_approval", "disabled_by_config"].includes(stage.status));
    const reachedApplyGate = input.events.some((event) =>
      [
        "terraform_apply_gate_passed",
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
      if (blocker && ["not_started", "pending"].includes(stage.status)) {
        stage.status = "blocked";
        stage.blockedByStage = blocker.stage;
        stage.blockedReason = blocker.message;
        stage.message = blocker.stage === "terraform_apply_gate" ? "Blocked at Terraform Apply Gate." : `Blocked by ${blocker.label}.`;
        stage.canRetry = false;
      }
      if (!blocker && stage.required && ["failed", "requires_approval", "disabled_by_config"].includes(stage.status)) blocker = stage;
    }
  }

  private emptyStage(definition: StageDefinition): ResolvedPipelineStage {
    return {
      stage: definition.stage,
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
}

function definition(stage: string, label: string, required: boolean, canSkip: boolean, source: string, tokens: string[]): StageDefinition {
  return { stage, label, required, canSkip, source, matches: (eventStage) => tokens.some((token) => eventStage.includes(token)) };
}

function normalize(value: unknown) {
  return String(value || "").toLowerCase();
}

function stageByName(stages: ResolvedPipelineStage[], name: string) {
  return stages.find((stage) => stage.stage === name)!;
}
