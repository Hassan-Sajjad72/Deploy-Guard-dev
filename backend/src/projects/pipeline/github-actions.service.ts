import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

export type GithubActionsDiagnosticCode =
  | "workflow_file_missing"
  | "workflow_dispatch_missing"
  | "wrong_branch"
  | "token_missing"
  | "token_no_repo_access"
  | "token_no_actions_write"
  | "github_actions_disabled"
  | "repo_not_found_or_permission_denied"
  | "invalid_workflow_inputs"
  | "unknown_github_error";

export class GithubActionsDispatchError extends Error {
  constructor(public readonly diagnosticCode: GithubActionsDiagnosticCode) {
    super(
      "GitHub Actions dispatch failed. Check workflow file, selected branch, workflow_dispatch, token repo access, and Actions write permission."
    );
  }
}

@Injectable()
export class GithubActionsService {
  constructor(private readonly config: ConfigService) {}

  getWorkflowFile() {
    return this.config.get<string>("GITHUB_ACTIONS_WORKFLOW_FILE", "deploy.yml");
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
      throw new GithubActionsDispatchError(token ? "workflow_file_missing" : "token_missing");
    }

    let response: Response;

    try {
      response = await fetch(
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
    } catch {
      throw new GithubActionsDispatchError("unknown_github_error");
    }

    if (!response.ok) {
      const responseMessage = await this.safeResponseMessage(response);
      throw new GithubActionsDispatchError(
        await this.dispatchDiagnosticCode(
          response.status,
          responseMessage,
          input,
          token
        )
      );
    }

    return { status: "dispatched", workflowRunId: null };
  }

  private async dispatchDiagnosticCode(
    status: number,
    message: string,
    input: { repositoryFullName: string; targetBranch: string },
    token: string
  ): Promise<GithubActionsDiagnosticCode> {
    const normalized = message.toLowerCase();
    if (status === 401) return "token_no_repo_access";
    if (status === 403 && normalized.includes("actions disabled")) return "github_actions_disabled";
    if (status === 403) return "token_no_actions_write";
    if (status === 404) {
      const repositoryVisible = await this.githubResourceExists(
        `https://api.github.com/repos/${input.repositoryFullName}`,
        token
      );
      return repositoryVisible
        ? "workflow_file_missing"
        : "repo_not_found_or_permission_denied";
    }
    if (status === 422 && normalized.includes("workflow_dispatch")) return "workflow_dispatch_missing";
    if (status === 422) {
      const branchExists = await this.githubResourceExists(
        `https://api.github.com/repos/${input.repositoryFullName}/branches/${encodeURIComponent(input.targetBranch)}`,
        token
      );
      if (!branchExists || normalized.includes("ref") || normalized.includes("branch")) {
        return "wrong_branch";
      }
    }
    if (status === 422) return "invalid_workflow_inputs";
    return "unknown_github_error";
  }

  private async githubResourceExists(url: string, token: string) {
    try {
      const response = await fetch(url, {
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "User-Agent": "Deploy-Guard",
        },
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  private async safeResponseMessage(response: Response) {
    try {
      const body = (await response.json()) as { message?: unknown };
      return typeof body.message === "string" ? body.message.slice(0, 300) : "";
    } catch {
      return "";
    }
  }
}
