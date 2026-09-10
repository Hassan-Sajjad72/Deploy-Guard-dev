import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { PipelineRunStatus, ProjectPipelineRun } from "../projects/project-pipeline-run.entity";
import { ProjectPipelineEvent } from "../projects/project-pipeline-event.entity";
import { ProjectObservabilityEvent } from "../observability/project-observability-event.entity";
import { CloudWatchLogsService } from "../observability/cloudwatch-logs.service";
import { ProjectEnvironmentVariable } from "../projects/project-environment-variable.entity";
import { ProjectEnvironmentCryptoService } from "../projects/project-environment-crypto.service";
import { User } from "../users/user.entity";
import { AiEvidencePreprocessorService, RawEvidence } from "./ai-evidence-preprocessor.service";
import { currentFailureDiagnostic } from "../projects/failure-diagnostics/failure-diagnostic.service";

function immutableFailureBuildContext(run: ProjectPipelineRun) {
  try {
    const inputs = run.metadata?.immutableDispatchInputs as Record<string, unknown> | undefined;
    const encoded = inputs?.services_base64;
    if (typeof encoded !== "string" || !run.failureServiceId) return null;
    const runtime = JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as { services?: Array<Record<string, unknown>> };
    const service = runtime.services?.find((item) => item.serviceId === run.failureServiceId);
    const target = service?.buildTarget as Record<string, unknown> | undefined;
    if (!service || !target) return null;
    return {
      serviceId: service.serviceId, serviceName: service.serviceName, serviceDirectory: service.serviceDirectory,
      buildTargetRevisionId: service.buildTargetRevisionId, buildTargetFingerprint: target.fingerprint,
      buildTargetContract: target.contract, buildRoot: target.buildRoot, runtimeConfigRevisionId: service.runtimeConfigRevisionId,
      runtimeConfigFingerprint: service.runtimeConfigFingerprint, railpackBuildCapabilityFingerprint: service.railpackBuildCapabilityFingerprint || null,
    };
  } catch { return null; }
}

@Injectable()
export class AiEvidenceService {
  constructor(
    @InjectRepository(ProjectPipelineRun) private readonly runs: Repository<ProjectPipelineRun>,
    @InjectRepository(ProjectPipelineEvent) private readonly pipelineEvents: Repository<ProjectPipelineEvent>,
    @InjectRepository(ProjectObservabilityEvent) private readonly observabilityEvents: Repository<ProjectObservabilityEvent>,
    @InjectRepository(ProjectEnvironmentVariable) private readonly environmentVariables: Repository<ProjectEnvironmentVariable>,
    private readonly preprocessor: AiEvidencePreprocessorService,
    private readonly environmentCrypto: ProjectEnvironmentCryptoService,
    private readonly cloudWatchLogs: CloudWatchLogsService,
  ) {}

  async collect(projectId: string, pipelineRunId: string, user?: User, serviceId?: string | null) {
    const run = await this.runs.findOne({ where: { id: pipelineRunId, projectId } });
    const stage = typeof run?.metadata?.failedStage === "string" ? run.metadata.failedStage : run?.currentStage;
    const rows: RawEvidence[] = [];
    const diagnosis = run ? currentFailureDiagnostic(run) : null;
    const buildContext = run ? immutableFailureBuildContext(run) : null;
    let runtimeServiceId: string | null = null;
    const failedSource = /terraform/i.test(String(stage || "")) ? "terraform" : /railpack|build|application_runtime/i.test(String(stage || "")) ? "railpack_build" : "github_actions";
    if (typeof run?.metadata?.safeLog === "string" && run.metadata.safeLog.trim()) rows.push({ source: failedSource, stage, eventId: run.githubWorkflowRunId, timestamp: run.failedAt, text: run.metadata.safeLog });
    if (run?.errorMessage) rows.push({ source: "github_actions_status", stage, eventId: run.githubWorkflowRunId, timestamp: run.failedAt, text: run.errorMessage });
    if (diagnosis) rows.push({ source: "deployguard_diagnosis", stage, eventId: run?.id, timestamp: run?.failedAt, text: JSON.stringify(diagnosis) });
    if (run && (buildContext || run.metadata?.builderFailure)) rows.push({ source: "deployguard_build_identity", stage, eventId: run.id, timestamp: run.failedAt || run.updatedAt, text: JSON.stringify({ buildIdentity: buildContext, builderFailure: run.metadata?.builderFailure || null }) });
    if (run?.metadata?.terraformPlanSummary) rows.push({ source: "terraform", stage, eventId: run.id, timestamp: run.updatedAt, text: `Terraform plan summary: ${JSON.stringify(run.metadata.terraformPlanSummary)}` });
    if (run) rows.push({ source: "deployguard_lifecycle", stage, eventId: run.id, timestamp: run.updatedAt, text: JSON.stringify({ operationId: run.id, generationId: run.generationId, commitSha: run.commitSha, deploymentAction: run.metadata?.deploymentAction, failedStage: run.metadata?.failedStage, status: run.status, failureOwner: run.failureOwner, externalProvider: run.externalProvider, failureCode: run.failureCode, failureServiceId: run.failureServiceId }) });
    if (run) {
      const [events, runtimeEvents] = await Promise.all([
        this.pipelineEvents.find({ where: { projectId, pipelineRunId }, order: { sequenceNumber: "ASC", occurredAt: "ASC" }, take: 200 }),
        this.observabilityEvents.find({ where: { projectId, pipelineRunId }, order: { createdAt: "ASC" }, take: 100 }),
      ]);
      for (const event of events) {
        const source = event.stage.includes("terraform") ? "terraform"
          : event.source === "github_actions" ? "github_actions"
            : "deployguard_lifecycle";
        rows.push({ source, stage: event.stage, eventId: event.id, timestamp: event.occurredAt, text: `[${event.status}] ${event.message}` });
      }
      for (const event of runtimeEvents) rows.push({ source: "ecs_cloudwatch_runtime", stage: event.eventType, eventId: event.id, timestamp: event.createdAt, text: `[${event.status}] ${event.message}` });
      for (const [index, workflowStage] of (Array.isArray(run.metadata?.workflowStages) ? run.metadata.workflowStages : []).entries()) {
        if (!workflowStage || typeof workflowStage !== "object") continue;
        const item = workflowStage as Record<string, unknown>;
        rows.push({ source: "github_actions_stage", stage: String(item.key || "workflow_stage"), eventId: `${run.githubWorkflowRunId || run.id}:stage:${index}`, timestamp: String(item.completedAt || item.startedAt || run.updatedAt), text: `[${String(item.status || "unknown")}] ${String(item.label || item.key || "Workflow stage")}${item.failureReason ? `: ${String(item.failureReason)}` : ""}` });
      }
      const releaseArtifact = run.metadata?.releaseArtifact;
      if (releaseArtifact && typeof releaseArtifact === "object") {
        const artifact = releaseArtifact as Record<string, unknown>;
        if (artifact.operationId === run.id && artifact.sourceSha === run.commitSha && artifact.awsRuntimeVerification) {
          rows.push({ source: "aws_runtime_verification", stage: "aws_runtime_verification", eventId: run.id, timestamp: run.completedAt || run.updatedAt, text: JSON.stringify(artifact.awsRuntimeVerification) });
        }
      }
      if (run.status === PipelineRunStatus.COMPLETED && run.generationId && run.metadata?.releaseEvidenceVerified === true && user) {
        try {
          const logs = await this.cloudWatchLogs.getRecentLogs(user, projectId, { since: (run.completedAt || run.updatedAt).toISOString() }, serviceId || undefined);
          if (logs.available && logs.generationId === run.generationId) {
            runtimeServiceId = logs.serviceId;
            for (const event of logs.events.slice(-100)) rows.push({ source: "cloudwatch_runtime", stage: "application_runtime", eventId: event.id, timestamp: event.timestamp, text: event.message, lineReference: event.source });
          }
        } catch {
          // A LIVE runtime issue is eligible only when real, matching-generation
          // CloudWatch evidence exists. Provider absence is not fabricated.
        }
      }
    }
    const environmentValues = await this.rawEnvironmentValues(projectId);
    const evidence = this.preprocessor.preprocess(rows, environmentValues);
    const runtimeEvidence = evidence.filter((row) => row.source === "cloudwatch_runtime");
    return {
      context: {
        pipelineRunId,
        workflowRunId: run?.githubWorkflowRunId || null,
        failedStage: stage || null,
        generationId: run?.generationId || null,
        operationType: run?.metadata?.deploymentAction || null,
        commitSha: run?.commitSha || null,
        failedAt: run?.failedAt?.toISOString() || null,
        failureOwner: diagnosis?.failureOwner || run?.failureOwner || "UNVERIFIED",
        externalProvider: diagnosis?.externalProvider ?? run?.externalProvider ?? null,
        failureCode: diagnosis?.terminalFailureCode || run?.failureCode || null,
        failureServiceId: diagnosis?.serviceId || run?.failureServiceId || null,
        buildIdentity: buildContext,
        builderFailure: run?.metadata?.builderFailure || null,
        failureDiagnostic: diagnosis,
        rootCauseCode: diagnosis?.rootCauseCode || null,
        retryDecision: diagnosis?.retryDecision || null,
        requestedServiceId: serviceId || null,
        runtimeServiceId: runtimeEvidence.length ? runtimeServiceId : null,
        problemType: run?.status === PipelineRunStatus.COMPLETED ? "LIVE_RUNTIME_ISSUE" : "FAILED_DEPLOYMENT",
        evidenceSources: Object.fromEntries([...new Set(evidence.map((row) => row.source))].map((source) => [source, evidence.filter((row) => row.source === source).length])),
      },
      evidence,
      groups: Object.fromEntries([...new Set(evidence.map((row) => row.source))].map((source) => [source, evidence.filter((row) => row.source === source)])),
    };
  }

  async sanitizeUserInput(projectId: string, value: string) {
    return this.preprocessor.sanitizeText(value, await this.rawEnvironmentValues(projectId)).replace(/[\u0000-\u001F\u007F]/g, " ").trim().slice(0, 1000);
  }

  private async rawEnvironmentValues(projectId: string) {
    try {
      const rows = await this.environmentVariables.createQueryBuilder("variable")
        .addSelect("variable.value")
        .where("variable.project_id = :projectId", { projectId })
        .andWhere("variable.is_active = true")
        .getMany();
      return rows.flatMap((row) => {
        try { return [this.environmentCrypto.decrypt(row.value)]; } catch { return []; }
      });
    } catch { return []; }
  }
}
