import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { inflateRawSync } from "node:zlib";
import { RAILPACK_CALLER_INPUT_NAMES, RAILPACK_OPTIONAL_CALLER_INPUT_NAMES, RAILPACK_WORKFLOW_INPUTS } from "../railpack-workflow-contract";

export type GithubActionsDiagnosticCode =
  | "workflow_file_missing"
  | "workflow_dispatch_missing"
  | "wrong_branch"
  | "token_missing"
  | "token_no_repo_access"
  | "token_no_actions_write"
  | "github_actions_disabled"
  | "workflow_run_identity_missing"
  | "repo_not_found_or_permission_denied"
  | "invalid_workflow_inputs"
  | "unknown_github_error";

export class GithubActionsDispatchError extends Error {
  constructor(
    public readonly diagnosticCode: GithubActionsDiagnosticCode,
    public readonly safeDetail: string | null = null,
    public readonly evidence: GithubActionsDispatchEvidence | null = null,
  ) {
    super(
      "GitHub Actions dispatch failed. Check workflow file, selected branch, workflow_dispatch, token repo access, and Actions write permission."
    );
  }
}

export type GithubActionsDispatchEvidence = {
  classification: GithubActionsDiagnosticCode;
  httpStatus: number | null;
  message: string;
  workflow: string;
  repository: string;
  ref: string;
  inputNames: string[];
  operationId: string | null;
  failedAt: string;
};

export type GithubActionsDispatchReceipt = {
  httpStatus: number;
  workflow: string;
  repository: string;
  ref: string;
  inputNames: string[];
  operationId: string | null;
  apiVersion: "2026-03-10";
  authentication: "Bearer installation token";
  workflowRunId: string;
  workflowRunUrl: string | null;
};

export function compactGithubWorkflowInputs(inputs?: Record<string, string>) {
  if (!inputs) return undefined;
  return Object.fromEntries(Object.entries(inputs).filter(([, value]) => value !== ""));
}

export function githubWorkflowDispatchInputs(inputs?: Record<string, string>) {
  if (!inputs) return undefined;
  const allowed = new Set(RAILPACK_CALLER_INPUT_NAMES);
  const unknown = Object.keys(inputs).find((name) => !allowed.has(name as typeof RAILPACK_CALLER_INPUT_NAMES[number]));
  if (unknown) throw new GithubActionsDispatchError("invalid_workflow_inputs", `Unknown Railpack workflow input: ${unknown}.`);
  const optional = new Set<string>(RAILPACK_OPTIONAL_CALLER_INPUT_NAMES);
  for (const input of RAILPACK_WORKFLOW_INPUTS) {
    if (!optional.has(input.name) && !String(inputs[input.name] || "").trim()) {
      throw new GithubActionsDispatchError("invalid_workflow_inputs", `Required Railpack workflow input is missing: ${input.name}.`);
    }
  }
  return compactGithubWorkflowInputs(inputs);
}

export function exactZipEntry(archive: Buffer, expectedName: string, maxEntryBytes = 512 * 1024) {
  const minimumEocd = 22;
  const searchStart = Math.max(0, archive.length - 65_557);
  let eocd = -1;
  for (let offset = archive.length - minimumEocd; offset >= searchStart; offset -= 1) {
    if (archive.readUInt32LE(offset) === 0x06054b50) { eocd = offset; break; }
  }
  if (eocd < 0) throw new GithubActionsDispatchError("unknown_github_error", "The DeployGuard result artifact is not a valid ZIP archive.");
  const entryCount = archive.readUInt16LE(eocd + 10);
  let cursor = archive.readUInt32LE(eocd + 16);
  for (let index = 0; index < entryCount; index += 1) {
    if (archive.readUInt32LE(cursor) !== 0x02014b50) break;
    const method = archive.readUInt16LE(cursor + 10);
    const compressedSize = archive.readUInt32LE(cursor + 20);
    const uncompressedSize = archive.readUInt32LE(cursor + 24);
    const nameLength = archive.readUInt16LE(cursor + 28);
    const extraLength = archive.readUInt16LE(cursor + 30);
    const commentLength = archive.readUInt16LE(cursor + 32);
    const localOffset = archive.readUInt32LE(cursor + 42);
    const name = archive.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");
    if (name === expectedName) {
      if (uncompressedSize > maxEntryBytes || localOffset + 30 > archive.length || archive.readUInt32LE(localOffset) !== 0x04034b50) {
        throw new GithubActionsDispatchError("unknown_github_error", "The DeployGuard result artifact is invalid or too large.");
      }
      const localNameLength = archive.readUInt16LE(localOffset + 26);
      const localExtraLength = archive.readUInt16LE(localOffset + 28);
      const dataStart = localOffset + 30 + localNameLength + localExtraLength;
      const compressed = archive.subarray(dataStart, dataStart + compressedSize);
      const result = method === 0 ? compressed : method === 8 ? inflateRawSync(compressed) : null;
      if (!result || result.length !== uncompressedSize) throw new GithubActionsDispatchError("unknown_github_error", "The DeployGuard result artifact compression is unsupported.");
      return result.toString("utf8");
    }
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return null;
}

export const DEPLOYGUARD_RESULT_ARTIFACT_ENTRY = "terraform/deployguard-result.json";

export type GithubActionsTerminalFailureEvidence = {
  failedStage: string;
  rawEvidence: string;
  workflowStages: Array<{ key: string; label: string; status: "failed" | "passed" | "running" | "skipped"; startedAt: string | null; completedAt: string | null; jobUrl: string | null; failureReason: string | null }>;
};

@Injectable()
export class GithubActionsService {
  constructor(private readonly config: ConfigService) {}

  getWorkflowFile() {
    return this.config.get<string>("GITHUB_ACTIONS_WORKFLOW_FILE", "deployguard.yml");
  }

  async triggerWorkflow(input: {
    repositoryFullName: string;
    targetBranch: string;
    token?: string;
    inputs?: Record<string, string>;
    excludedWorkflowRunIds?: string[];
  }): Promise<{ status: "dispatch_accepted"; workflowRunId: string; receipt: GithubActionsDispatchReceipt }> {
    const token = input.token?.trim();
    const workflowFile = this.config.get<string>(
      "GITHUB_ACTIONS_WORKFLOW_FILE",
      "deployguard.yml"
    );

    if (!token || !workflowFile) {
      throw new GithubActionsDispatchError(token ? "workflow_file_missing" : "token_missing");
    }

    const dispatchInputs = githubWorkflowDispatchInputs(input.inputs) || {};
    const inputNames = Object.keys(dispatchInputs).sort();
    const operationId = input.inputs?.deployment_operation_id || null;
    if (input.inputs && (input.repositoryFullName !== input.inputs.repository_full_name || input.targetBranch !== input.inputs.repository_branch)) {
      const detail = "Dispatch repository and ref do not match the immutable deployment snapshot.";
      throw new GithubActionsDispatchError("invalid_workflow_inputs", detail, this.failureEvidence("invalid_workflow_inputs", null, detail, workflowFile, input.repositoryFullName, input.targetBranch, inputNames, operationId));
    }
    await this.validateDispatchTarget(input.repositoryFullName, input.targetBranch, workflowFile, token, inputNames, operationId);
    let response: Response;

    try {
      response = await fetch(
        `https://api.github.com/repos/${input.repositoryFullName}/actions/workflows/${encodeURIComponent(
          workflowFile
        )}/dispatches`,
        {
          method: "POST",
          headers: {
            ...this.headers(token),
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            ref: input.targetBranch,
            ...(input.inputs ? { inputs: dispatchInputs } : {}),
            return_run_details: true,
          }),
        }
      );
    } catch {
      throw new GithubActionsDispatchError("unknown_github_error");
    }

    if (!response.ok) {
      const responseMessage = await this.safeResponseMessage(response);
      const diagnosticCode = await this.dispatchDiagnosticCode(
          response.status,
          responseMessage,
          input,
          token
        );
      const detail = this.safeDispatchFailureDetail(responseMessage);
      throw new GithubActionsDispatchError(diagnosticCode, detail, this.failureEvidence(diagnosticCode, response.status, detail, workflowFile, input.repositoryFullName, input.targetBranch, inputNames, operationId));
    }

    const dispatchResult = await response.json().catch(() => null) as { workflow_run_id?: number | string; html_url?: string } | null;
    let workflowRunId = String(dispatchResult?.workflow_run_id || "").trim();
    let correctedStaleRunIdentity = false;
    if (!/^\d+$/.test(workflowRunId)) {
      const detail = "GitHub accepted the workflow request without returning an immutable workflow run identity.";
      throw new GithubActionsDispatchError(
        "workflow_run_identity_missing",
        detail,
        this.failureEvidence("workflow_run_identity_missing", response.status, detail, workflowFile, input.repositoryFullName, input.targetBranch, inputNames, operationId),
      );
    }
    const excludedRunIds = new Set(input.excludedWorkflowRunIds || []);
    if (excludedRunIds.has(workflowRunId)) {
      const dispatchedAt = new Date();
      let discoveredRunId: string | null = null;
      for (let attempt = 0; attempt < 10 && !discoveredRunId; attempt += 1) {
        if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 2_000));
        discoveredRunId = await this.findWorkflowRunAfter(
          input.repositoryFullName,
          input.targetBranch,
          dispatchedAt,
          token,
          [...excludedRunIds],
        );
      }
      if (!discoveredRunId) {
        const detail = "GitHub returned a stale workflow run identity and did not expose the newly accepted run within the bounded discovery window.";
        throw new GithubActionsDispatchError(
          "workflow_run_identity_missing",
          detail,
          this.failureEvidence("workflow_run_identity_missing", response.status, detail, workflowFile, input.repositoryFullName, input.targetBranch, inputNames, operationId),
        );
      }
      workflowRunId = discoveredRunId;
      correctedStaleRunIdentity = true;
    }
    return {
      status: "dispatch_accepted",
      workflowRunId,
      receipt: {
        httpStatus: response.status,
        workflow: workflowFile,
        repository: input.repositoryFullName,
        ref: input.targetBranch,
        inputNames,
        operationId,
        apiVersion: "2026-03-10",
        authentication: "Bearer installation token",
        workflowRunId,
        workflowRunUrl: correctedStaleRunIdentity
          ? `https://github.com/${input.repositoryFullName}/actions/runs/${workflowRunId}`
          : typeof dispatchResult?.html_url === "string" ? dispatchResult.html_url : null,
      },
    };
  }

  private async validateDispatchTarget(repository: string, branch: string, workflowFile: string, token: string, inputNames: string[], operationId: string | null) {
    const checks = [
      { url: `https://api.github.com/repos/${repository}`, code: "repo_not_found_or_permission_denied" as const, detail: "GitHub repository is not accessible to the installation token." },
      { url: `https://api.github.com/repos/${repository}/branches/${encodeURIComponent(branch)}`, code: "wrong_branch" as const, detail: "The selected GitHub branch does not exist or is not accessible." },
    ];
    for (const check of checks) {
      const response = await fetch(check.url, { headers: this.headers(token) });
      if (!response.ok) {
        const code = response.status === 401 || response.status === 403 ? "token_no_repo_access" : check.code;
        throw new GithubActionsDispatchError(code, check.detail, this.failureEvidence(code, response.status, check.detail, workflowFile, repository, branch, inputNames, operationId));
      }
    }
    const path = workflowFile.includes("/") ? workflowFile : `.github/workflows/${workflowFile}`;
    const response = await fetch(`https://api.github.com/repos/${repository}/contents/${path}?ref=${encodeURIComponent(branch)}`, { headers: this.headers(token) });
    if (!response.ok) {
      const detail = "The expected workflow file does not exist on the selected branch.";
      throw new GithubActionsDispatchError("workflow_file_missing", detail, this.failureEvidence("workflow_file_missing", response.status, detail, workflowFile, repository, branch, inputNames, operationId));
    }
    const body = await response.json() as { content?: string; encoding?: string };
    const content = body.encoding === "base64" && body.content ? Buffer.from(body.content.replace(/\n/g, ""), "base64").toString("utf8") : "";
    if (!/^on:\s*\n\s+workflow_dispatch:\s*$/m.test(content)) {
      const detail = "The expected workflow does not expose workflow_dispatch.";
      throw new GithubActionsDispatchError("workflow_dispatch_missing", detail, this.failureEvidence("workflow_dispatch_missing", null, detail, workflowFile, repository, branch, inputNames, operationId));
    }
    const definitions = content.match(/\n    inputs:\n([\s\S]*?)\npermissions:/)?.[1] || "";
    const declared = [...definitions.matchAll(/^\s{6}([a-z][a-z0-9_]*):\s*\{/gm)].map((match) => match[1]).sort();
    const expected = [...RAILPACK_CALLER_INPUT_NAMES].sort();
    const required = expected.filter((name) => !RAILPACK_OPTIONAL_CALLER_INPUT_NAMES.includes(name as typeof RAILPACK_OPTIONAL_CALLER_INPUT_NAMES[number]));
    if (declared.length !== expected.length || declared.some((name, index) => name !== expected[index]) || inputNames.some((name) => !declared.includes(name)) || required.some((name) => !inputNames.includes(name))) {
      const detail = "Generated workflow input names do not match the canonical DeployGuard dispatch contract.";
      throw new GithubActionsDispatchError("invalid_workflow_inputs", detail, this.failureEvidence("invalid_workflow_inputs", null, detail, workflowFile, repository, branch, inputNames, operationId));
    }
    const workflowResponse = await fetch(`https://api.github.com/repos/${repository}/actions/workflows/${encodeURIComponent(workflowFile)}`, { headers: this.headers(token) });
    if (!workflowResponse.ok) {
      const code: GithubActionsDiagnosticCode = workflowResponse.status === 401 || workflowResponse.status === 403 ? "token_no_repo_access" : "workflow_file_missing";
      const detail = "GitHub does not expose the expected workflow to the installation token.";
      throw new GithubActionsDispatchError(code, detail, this.failureEvidence(code, workflowResponse.status, detail, workflowFile, repository, branch, inputNames, operationId));
    }
    const workflow = await workflowResponse.json() as { state?: string };
    if (workflow.state && workflow.state !== "active") {
      const detail = "The expected GitHub Actions workflow is not active.";
      throw new GithubActionsDispatchError("github_actions_disabled", detail, this.failureEvidence("github_actions_disabled", null, detail, workflowFile, repository, branch, inputNames, operationId));
    }
  }

  private failureEvidence(classification: GithubActionsDiagnosticCode, httpStatus: number | null, message: string, workflow: string, repository: string, ref: string, inputNames: string[], operationId: string | null): GithubActionsDispatchEvidence {
    return { classification, httpStatus, message, workflow, repository, ref, inputNames: [...inputNames].sort(), operationId, failedAt: new Date().toISOString() };
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
    return response.json() as Promise<{ jobs?: Array<{
      id?: number;
      name?: string;
      status?: string;
      conclusion?: string | null;
      html_url?: string;
      started_at?: string | null;
      completed_at?: string | null;
      steps?: Array<{
        name?: string;
        status?: string;
        conclusion?: string | null;
        number?: number;
        started_at?: string | null;
        completed_at?: string | null;
      }>;
    }> }>;
  }

  async getJobLog(repository: string, jobId: number, token: string) {
    const response = await fetch(`https://api.github.com/repos/${repository}/actions/jobs/${jobId}/logs`, { headers: this.headers(token), redirect: "follow" });
    if (!response.ok) throw new GithubActionsDispatchError("unknown_github_error");
    return response.text();
  }

  /**
   * Collect only bounded evidence for a terminal failure. This deliberately
   * works for bootstrap failures where no deployment artifact exists.
   */
  async getTerminalFailureEvidence(repository: string, workflowRunId: string, token: string): Promise<GithubActionsTerminalFailureEvidence | null> {
    const response = await this.getWorkflowJobs(repository, workflowRunId, token);
    const jobs = response.jobs || [];
    const failed = jobs.find((job) => String(job.conclusion || "").toLowerCase() === "failure")
      || jobs.find((job) => String(job.status || "").toLowerCase() === "completed" && String(job.conclusion || "").toLowerCase() !== "success");
    if (!failed) return null;
    const failedStep = (failed.steps || []).find((step) => String(step.conclusion || "").toLowerCase() === "failure");
    const normalized = (value: unknown) => String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
    const failedStage = normalized(failedStep?.name) || normalized(failed.name) || "workflow_bootstrap";
    const workflowStages = (failed.steps || []).map((step) => ({
      key: normalized(step.name) || "workflow_bootstrap",
      label: String(step.name || "GitHub Actions workflow bootstrap"),
      status: String(step.conclusion || step.status || "").toLowerCase() === "failure" ? "failed" as const
        : String(step.conclusion || step.status || "").toLowerCase() === "skipped" ? "skipped" as const
          : String(step.status || "").toLowerCase() === "in_progress" ? "running" as const : "passed" as const,
      startedAt: step.started_at || null, completedAt: step.completed_at || null,
      jobUrl: failed.html_url || null,
      failureReason: String(step.conclusion || "").toLowerCase() === "failure" ? `GitHub Actions step failed: ${String(step.name || "workflow bootstrap")}` : null,
    }));
    const summary = [
      `GitHub Actions job: ${String(failed.name || "workflow bootstrap")}`,
      `Job status: ${String(failed.status || "completed")}`,
      `Job conclusion: ${String(failed.conclusion || "failure")}`,
      failedStep ? `Failed step: ${String(failedStep.name || "workflow bootstrap")}` : "Failed before a runnable workflow step was recorded.",
    ];
    if (typeof failed.id === "number") {
      try {
        const log = await this.getJobLog(repository, failed.id, token);
        // Keep the terminal diagnostic area only; sanitation is applied by the
        // caller before persistence.
        summary.push(log.slice(-12_000));
      } catch {
        // Job metadata remains valid bounded evidence when logs are withheld.
      }
    }
    return { failedStage, rawEvidence: summary.join("\n").slice(0, 16_000), workflowStages };
  }

  async getResultArtifact(repository: string, workflowRunId: string, operationId: string, token: string) {
    return this.getArtifactEntry(repository, workflowRunId, operationId, token, DEPLOYGUARD_RESULT_ARTIFACT_ENTRY, 512 * 1024);
  }

  async getArtifactEntry(repository: string, workflowRunId: string, operationId: string, token: string, entryName: string, maxEntryBytes: number) {
    const name = `deployguard-result-${operationId}`;
    const list = await fetch(`https://api.github.com/repos/${repository}/actions/runs/${workflowRunId}/artifacts?name=${encodeURIComponent(name)}&per_page=10`, { headers: this.headers(token) });
    if (!list.ok) throw new GithubActionsDispatchError("unknown_github_error", "GitHub did not expose the DeployGuard result artifact.");
    const body = await list.json() as { artifacts?: Array<{ id?: number; name?: string; expired?: boolean }> };
    const artifacts = (body.artifacts || []).filter((artifact) => artifact.name === name && artifact.expired !== true && artifact.id);
    if (artifacts.length === 0) return null;
    if (artifacts.length !== 1) throw new GithubActionsDispatchError("unknown_github_error", "The DeployGuard result artifact identity is ambiguous.");
    const download = await fetch(`https://api.github.com/repos/${repository}/actions/artifacts/${artifacts[0].id}/zip`, { headers: this.headers(token), redirect: "follow" });
    if (!download.ok) throw new GithubActionsDispatchError("unknown_github_error", "The DeployGuard result artifact could not be downloaded.");
    const contentLength = Number(download.headers.get("content-length") || 0);
    const maxArchiveBytes = Math.min(Math.max(maxEntryBytes * 2, 2 * 1024 * 1024), 32 * 1024 * 1024);
    if (contentLength > maxArchiveBytes) throw new GithubActionsDispatchError("unknown_github_error", "The DeployGuard result artifact is too large.");
    const archive = Buffer.from(await download.arrayBuffer());
    if (archive.length > maxArchiveBytes) throw new GithubActionsDispatchError("unknown_github_error", "The DeployGuard result artifact is too large.");
    return exactZipEntry(archive, entryName, maxEntryBytes);
  }

  private headers(token: string) { return { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "User-Agent": "Deploy-Guard", "X-GitHub-Api-Version": "2026-03-10" }; }

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

  private safeDispatchFailureDetail(message: string) {
    const normalized = message.replace(/\s+/g, " ").trim();
    const required = normalized.match(/^Required input '([a-z][a-z0-9_]*)' not provided$/);
    if (required) return `GitHub requires workflow input ${required[1]}.`;
    const propertyLimit = normalized.match(/^Invalid request\. No more than ([0-9]+) properties are allowed; ([0-9]+) were supplied\.$/);
    if (propertyLimit) return `GitHub accepts at most ${propertyLimit[1]} workflow inputs; ${propertyLimit[2]} were supplied.`;
    if (/^Workflow does not have 'workflow_dispatch' trigger\.?$/.test(normalized)) {
      return "GitHub reports that the selected workflow revision does not expose workflow_dispatch.";
    }
    const redacted = normalized
      .replace(/https?:\/\/\S+/g, "[link]")
      .replace(/[A-Za-z0-9+/_=-]{20,}/g, "[redacted]")
      .slice(0, 300);
    const printable = redacted.replace(/[^\x20-\x7E]/g, "").trim();
    return printable
      ? `GitHub rejected the dispatch: ${printable}`
      : "GitHub rejected the workflow dispatch before creating a run.";
  }
}
