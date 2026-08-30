import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { ProjectPipelineRun } from "../projects/project-pipeline-run.entity";
import { ProjectPipelineEvent } from "../projects/project-pipeline-event.entity";
import { ProjectObservabilityEvent } from "../observability/project-observability-event.entity";
import { AiEvidencePreprocessorService, RawEvidence } from "./ai-evidence-preprocessor.service";

@Injectable()
export class AiEvidenceService {
  constructor(
    @InjectRepository(ProjectPipelineRun) private readonly runs: Repository<ProjectPipelineRun>,
    @InjectRepository(ProjectPipelineEvent) private readonly pipelineEvents: Repository<ProjectPipelineEvent>,
    @InjectRepository(ProjectObservabilityEvent) private readonly observabilityEvents: Repository<ProjectObservabilityEvent>,
    private readonly preprocessor: AiEvidencePreprocessorService,
  ) {}

  async collect(projectId: string, pipelineRunId: string) {
    const run = await this.runs.findOne({ where: { id: pipelineRunId, projectId } });
    const stage = typeof run?.metadata?.failedStage === "string" ? run.metadata.failedStage : run?.currentStage;
    const rows: RawEvidence[] = [];
    const failedSource = String(stage || "").includes("terraform") ? "terraform" : "github_actions";
    if (typeof run?.metadata?.safeLog === "string" && run.metadata.safeLog.trim()) rows.push({ source: failedSource, stage, eventId: run.githubWorkflowRunId, timestamp: run.failedAt, text: run.metadata.safeLog });
    if (run?.errorMessage) rows.push({ source: "github_actions_status", stage, eventId: run.githubWorkflowRunId, timestamp: run.failedAt, text: run.errorMessage });
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
    }
    const evidence = this.preprocessor.preprocess(rows);
    return {
      context: {
        pipelineRunId,
        workflowRunId: run?.githubWorkflowRunId || null,
        failedStage: stage || null,
        generationId: run?.generationId || null,
        operationType: run?.metadata?.deploymentAction || null,
        commitSha: run?.commitSha || null,
        failedAt: run?.failedAt?.toISOString() || null,
        failureOwner: run?.failureOwner || "UNVERIFIED",
        externalProvider: run?.externalProvider || null,
        failureCode: run?.failureCode || null,
        failureServiceId: run?.failureServiceId || null,
        evidenceSources: Object.fromEntries([...new Set(evidence.map((row) => row.source))].map((source) => [source, evidence.filter((row) => row.source === source).length])),
      },
      evidence,
      groups: Object.fromEntries([...new Set(evidence.map((row) => row.source))].map((source) => [source, evidence.filter((row) => row.source === source)])),
    };
  }
}
