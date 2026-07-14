import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { ProjectPipelineRun } from "../projects/project-pipeline-run.entity";
import { LogSanitizerService } from "./log-sanitizer.service";
import { PipelineMetricsService } from "./pipeline-metrics.service";
import { StageMetricSource } from "./project-stage-metric.entity";

type GitHubWorkflowRun = {
  id?: number | string;
  name?: string;
  head_branch?: string;
  head_sha?: string;
  status?: string;
  conclusion?: string;
  created_at?: string;
  run_started_at?: string;
  updated_at?: string;
  html_url?: string;
};

@Injectable()
export class GithubActionsMetricsService {
  constructor(
    @InjectRepository(ProjectPipelineRun)
    private readonly runRepository: Repository<ProjectPipelineRun>,
    private readonly config: ConfigService,
    private readonly metrics: PipelineMetricsService,
    private readonly sanitizer: LogSanitizerService
  ) {}

  async fetchWorkflowRun(projectId: string, pipelineRunId: string) {
    const run = await this.runRepository.findOne({ where: { id: pipelineRunId, projectId } });

    if (!run?.githubWorkflowRunId || !run.repositoryFullName || !this.config.get<string>("GITHUB_TOKEN")) {
      return this.fallback(run);
    }

    const response = await fetch(`https://api.github.com/repos/${run.repositoryFullName}/actions/runs/${run.githubWorkflowRunId}`, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${this.config.get<string>("GITHUB_TOKEN")}`,
        "User-Agent": "Deploy-Guard",
      },
    });

    if (!response.ok) {
      return this.fallback(run, `github_api_${response.status}`);
    }

    return response.json() as Promise<GitHubWorkflowRun>;
  }

  async resolveWorkflowRunAfterDispatch(projectId: string, pipelineRunId: string) {
    return this.fetchWorkflowRun(projectId, pipelineRunId);
  }

  async getWorkflowRunDuration(projectId: string, pipelineRunId: string) {
    const workflowRun = await this.fetchWorkflowRun(projectId, pipelineRunId);
    return this.workflowDuration(workflowRun);
  }

  async saveGithubActionsMetric(projectId: string, pipelineRunId: string, workflowRun?: GitHubWorkflowRun | null) {
    const run = await this.runRepository.findOne({ where: { id: pipelineRunId, projectId } });
    const workflow = workflowRun || await this.fetchWorkflowRun(projectId, pipelineRunId);
    const durationMs = this.workflowDuration(workflow);
    const status = workflow?.conclusion === "failure" || workflow?.conclusion === "cancelled" ? "failed" : "succeeded";

    await this.metrics.startStage(projectId, pipelineRunId, "github_actions", StageMetricSource.GITHUB_ACTIONS, {
      workflowRunId: workflow?.id || run?.githubWorkflowRunId || null,
      workflowName: workflow?.name || null,
      branch: workflow?.head_branch || run?.targetBranch || null,
      commitSha: workflow?.head_sha || run?.commitSha || null,
      status: workflow?.status || run?.githubWorkflowStatus || "unknown",
      htmlUrl: workflow?.html_url || null,
    });

    return this.metrics.completeStage(projectId, pipelineRunId, "github_actions", {
      workflowRunId: workflow?.id || run?.githubWorkflowRunId || null,
      workflowName: workflow?.name || null,
      branch: workflow?.head_branch || run?.targetBranch || null,
      commitSha: workflow?.head_sha || run?.commitSha || null,
      status,
      durationMs,
      htmlUrl: workflow?.html_url || null,
    });
  }

  private fallback(run: ProjectPipelineRun | null, reason = "workflow_run_unresolved") {
    return {
      id: run?.githubWorkflowRunId || null,
      name: null,
      head_branch: run?.targetBranch || null,
      head_sha: run?.commitSha || null,
      status: run?.githubWorkflowStatus || "dispatched",
      conclusion: reason,
      created_at: run?.startedAt?.toISOString() || run?.createdAt?.toISOString(),
      run_started_at: run?.startedAt?.toISOString() || run?.createdAt?.toISOString(),
      updated_at: run?.completedAt?.toISOString() || run?.updatedAt?.toISOString(),
      html_url: null,
    };
  }

  private workflowDuration(workflowRun: GitHubWorkflowRun | null) {
    const startedAt = workflowRun?.run_started_at || workflowRun?.created_at;
    const completedAt = workflowRun?.updated_at;

    if (!startedAt || !completedAt) {
      return null;
    }

    return Math.max(0, new Date(completedAt).getTime() - new Date(startedAt).getTime());
  }
}
