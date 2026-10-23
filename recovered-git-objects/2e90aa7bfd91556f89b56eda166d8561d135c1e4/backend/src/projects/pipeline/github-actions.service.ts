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
    token?: string;
    inputs?: Record<string, string>;
  }): Promise<{ status: string; workflowRunId: string | null }> {
    const token = input.token?.trim();
    const workflowFile = this.config.get<string>(
      "GITHUB_ACTIONS_WORKFLOW_FILE",
      "deployguard.yml"
    );

    if (!token || !workflowFile) {
      throw new GithubActionsDispatchError(token ? "workflow_file_missing" : "token_missing");
    }

    const previousRunIds = await this.workflowRunIds(input.repositoryFullName, workflowFile, input.targetBranch, token);
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
          body: JSON.stringify({ ref: input.targetBranch, ...(input.inputs ? { inputs: input.inputs } : {}) }),
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

    const workflowRunId = await this.findDispatchedRun(input.repositoryFullName, workflowFile, input.targetBranch, token, previousRunIds);
    return { status: "dispatched", workflowRunId };
  }

  async getWorkflowRun(repositoryFullName: string, workflowRunId: string, token: string) {
    const response = await fetch(`https://api.github.com/repos/${repositoryFullName}/actions/runs/${workflowRunId}`, { headers: this.headers(token) });
    if (!response.ok) throw new GithubActionsDispatchError("unknown_github_error");
    return response.json() as Promise<Record<string, unknown>>;
  }

  async findWorkflowRunAfter(repository: string, branch: string, dispatchedAt: Date, token: string, excludedIds: string[] = []) {
    const workflowFile = this.config.get<string>("GITHUB_ACTIONS_WORKFLOW_FILE", "deployguard.yml");
    const response = await fetch(`https://api.github.com/repos/${repository}/actions/workflows/${encodeURIComponent(workflowFile)}/runs?event=workflow_dispatch&branch=${encodeURIComponent(branch)}&per_page=30`, { headers: this.headers(token) });
    if (!response.ok) return null;
    const body = await response.json() as { workflow_runs?: Array<{ id?: number; created_at?: string }> };
    const floor = dispatchedAt.getTime() - 5_000;
    const excluded = new Set(excludedIds);
    const match = (body.workflow_runs || []).find((run) => run.id && !excluded.has(String(run.id)) && Date.parse(String(run.created_at || "")) >= floor);
    return match?.id ? String(match.id) : null;
  }

  async getWorkflowJobs(repository: string, workflowRunId: string, token: string) {
    const response = await fetch(`https://api.github.com/repos/${repository}/actions/runs/${workflowRunId}/jobs?per_page=100`, { headers: this.headers(token) });
    if (!response.ok) throw new GithubActionsDispatchError("unknown_github_error");
    return response.json() as Promise<{ jobs?: Array<{ id?: number; name?: string; status?: string; conclusion?: string | null; html_url?: string; steps?: Array<{ name?: string; status?: string; conclusion?: string | null; number?: number }> }> }>;
  }

  async getJobLog(repository: string, jobId: number, token: string) {
    const response = await fetch(`https://api.github.com/repos/${repository}/actions/jobs/${jobId}/logs`, { headers: this.headers(token), redirect: "follow" });
    if (!response.ok) throw new GithubActionsDispatchError("unknown_github_error");
    return response.text();
  }

  private async findDispatchedRun(repository: string, workflowFile: string, branch: string, token: string, previousRunIds: Set<string>) {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      const response = await fetch(`https://api.github.com/repos/${repository}/actions/workflows/${encodeURIComponent(workflowFile)}/runs?event=workflow_dispatch&branch=${encodeURIComponent(branch)}&per_page=1`, { headers: this.headers(token) });
      if (response.ok) {
        const body = await response.json() as { workflow_runs?: Array<{ id?: number }> };
        const created = body.workflow_runs?.find((run) => run.id && !previousRunIds.has(String(run.id)));
        if (created?.id) return String(created.id);
      }
    }
    return null;
  }

  private async workflowRunIds(repository: string, workflowFile: string, branch: string, token: string) {
    const response = await fetch(`https://api.github.com/repos/${repository}/actions/workflows/${encodeURIComponent(workflowFile)}/runs?event=workflow_dispatch&branch=${encodeURIComponent(branch)}&per_page=30`, { headers: this.headers(token) });
    if (!response.ok) return new Set<string>();
    const body = await response.json() as { workflow_runs?: Array<{ id?: number }> };
    return new Set((body.workflow_runs || []).flatMap((run) => run.id ? [String(run.id)] : []));
  }

  private headers(token: string) { return { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "User-Agent": "Deploy-Guard", "X-GitHub-Api-Version": "2022-11-28" }; }

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
