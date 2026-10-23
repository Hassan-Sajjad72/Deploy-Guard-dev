import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { ProjectEnvironmentVariable } from "../projects/project-environment-variable.entity";
import { ProjectPipelineRun } from "../projects/project-pipeline-run.entity";
import { AiEvidencePreprocessorService, RawEvidence } from "./ai-evidence-preprocessor.service";

@Injectable()
export class AiEvidenceService {
  constructor(
    @InjectRepository(ProjectPipelineRun) private readonly runs: Repository<ProjectPipelineRun>,
    @InjectRepository(ProjectEnvironmentVariable) private readonly variables: Repository<ProjectEnvironmentVariable>,
    private readonly preprocessor: AiEvidencePreprocessorService,
  ) {}

  async collect(projectId: string, pipelineRunId: string) {
    const [run, environmentRows] = await Promise.all([
      this.runs.findOne({ where: { id: pipelineRunId, projectId } }),
      this.variables.createQueryBuilder("variable").addSelect("variable.value").where("variable.projectId = :projectId", { projectId }).getMany(),
    ]);
    const stage = typeof run?.metadata?.failedStage === "string" ? run.metadata.failedStage : run?.currentStage;
    const rows: RawEvidence[] = [];
    if (typeof run?.metadata?.safeLog === "string" && run.metadata.safeLog.trim()) rows.push({ source: "github_actions", stage, eventId: run.githubWorkflowRunId, timestamp: run.failedAt, text: run.metadata.safeLog });
    if (run?.errorMessage) rows.push({ source: "github_actions_status", stage, eventId: run.githubWorkflowRunId, timestamp: run.failedAt, text: run.errorMessage });
    return {
      context: {
        pipelineRunId,
        workflowRunId: run?.githubWorkflowRunId || null,
        failedStage: stage || null,
        evidenceSources: { githubActions: rows.length },
      },
      evidence: this.preprocessor.preprocess(rows, environmentRows.map((row) => row.value || "")),
    };
  }
}
