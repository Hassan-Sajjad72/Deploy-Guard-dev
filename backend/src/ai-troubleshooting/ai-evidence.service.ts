import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { ProjectPipelineRun } from "../projects/project-pipeline-run.entity";
import { AiEvidencePreprocessorService, RawEvidence } from "./ai-evidence-preprocessor.service";

@Injectable()
export class AiEvidenceService {
  constructor(
    @InjectRepository(ProjectPipelineRun) private readonly runs: Repository<ProjectPipelineRun>,
    private readonly preprocessor: AiEvidencePreprocessorService,
  ) {}

  async collect(projectId: string, pipelineRunId: string) {
    const run = await this.runs.findOne({ where: { id: pipelineRunId, projectId } });
    const stage = typeof run?.metadata?.failedStage === "string" ? run.metadata.failedStage : run?.currentStage;
    const rows: RawEvidence[] = [];
    if (typeof run?.metadata?.safeLog === "string" && run.metadata.safeLog.trim()) rows.push({ source: "github_actions", stage, eventId: run.githubWorkflowRunId, timestamp: run.failedAt, text: run.metadata.safeLog });
    if (run?.errorMessage) rows.push({ source: "github_actions_status", stage, eventId: run.githubWorkflowRunId, timestamp: run.failedAt, text: run.errorMessage });
    if (run) rows.push({ source: "immutable_operation", stage, eventId: run.id, timestamp: run.updatedAt, text: JSON.stringify({ operationId: run.id, generationId: run.generationId, commitSha: run.commitSha, deploymentAction: run.metadata?.deploymentAction, deploymentMode: run.metadata?.deploymentMode, deploymentContext: run.metadata?.deploymentContext, terraformPlanSummary: run.metadata?.terraformPlanSummary, destroyVerification: run.metadata?.destroyVerification, failedStage: run.metadata?.failedStage }) });
    return {
      context: {
        pipelineRunId,
        workflowRunId: run?.githubWorkflowRunId || null,
        failedStage: stage || null,
        generationId: run?.generationId || null,
        operationType: run?.metadata?.deploymentAction || null,
        evidenceSources: Object.fromEntries([...new Set(rows.map((row) => row.source))].map((source) => [source, rows.filter((row) => row.source === source).length])),
      },
      evidence: this.preprocessor.preprocess(rows),
    };
  }
}
