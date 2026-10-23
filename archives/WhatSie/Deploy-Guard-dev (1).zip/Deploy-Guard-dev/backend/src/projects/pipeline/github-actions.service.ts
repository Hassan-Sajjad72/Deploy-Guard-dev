import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

@Injectable()
export class GithubActionsService {
  constructor(private readonly config: ConfigService) {}

  hasConfig() {
    return Boolean(
      this.config.get<string>("GITHUB_TOKEN") &&
        this.config.get<string>("GITHUB_ACTIONS_WORKFLOW_FILE", "deploy.yml")
    );
  }

  async triggerWorkflow(input: {
    repositoryFullName: string;
    targetBranch: string;
  }): Promise<{ status: string; workflowRunId: string | null }> {
    const token = this.config.get<string>("GITHUB_TOKEN");
    const workflowFile = this.config.get<string>(
      "GITHUB_ACTIONS_WORKFLOW_FILE",
      "deploy.yml"
    );

    if (!token || !workflowFile) {
      return { status: "skipped_missing_config", workflowRunId: null };
    }

    const response = await fetch(
      `https://api.github.com/repos/${input.repositoryFullName}/actions/workflows/${encodeURIComponent(
        workflowFile
      )}/dispatches`,
      {
        method: "POST",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "User-Agent": "Deploy-Guard",
        },
        body: JSON.stringify({ ref: input.targetBranch }),
      }
    );

    if (!response.ok) {
      throw new Error("GitHub Actions workflow dispatch failed");
    }

    return { status: "dispatched", workflowRunId: null };
  }
}
