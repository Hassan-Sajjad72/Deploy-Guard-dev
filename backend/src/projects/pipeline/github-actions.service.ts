import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { inflateRawSync } from "node:zlib";
import { RAILPACK_CALLER_INPUT_NAMES, RAILPACK_OPTIONAL_CALLER_INPUT_NAMES, RAILPACK_WORKFLOW_INPUTS } from "../railpack-workflow-contract";
import { GithubActionsPresentationAction, githubActionsWorkflowStepPresentation } from "./github-actions-stage-presentation";

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
    public readonly dispatchMayHaveOccurred = false,
  ) {
    super(
      "GitHub Actions dispatch failed. Check workflow file, selected branch, workflow_dispatch, token repo access, and Actions write permission."
    );
  }
}

/** Invalid terminal evidence is distinct from a temporary GitHub outage. */
export class GithubActionsArtifactValidationError extends GithubActionsDispatchError {
  constructor(detail: string) { super("unknown_github_error", detail); }
}

export type GithubActionsDispatchEvidence = {
  classification: GithubActionsDiagnosticCode;
  httpStatus: number | null;
  message: string;
  workflow: string;
  repository: string;
  ref: string;
  sourceRef: string;
  inputNames: string[];
  operationId: string | null;
  failedAt: string;
};

export type GithubActionsDispatchReceipt = {
  httpStatus: number;
  workflow: string;
  repository: string;
  ref: string;
  sourceRef: string;
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
  const invalid = (): never => { throw new GithubActionsArtifactValidationError("The DeployGuard result artifact is invalid, ambiguous, or too large."); };
  if (!Number.isSafeInteger(maxEntryBytes) || maxEntryBytes < 1 || maxEntryBytes > 32 * 1024 * 1024) invalid();
  const minimumEocd = 22;
  const searchStart = Math.max(0, archive.length - 65_557);
  let eocd = -1;
  for (let offset = archive.length - minimumEocd; offset >= searchStart; offset -= 1) {
    if (archive.readUInt32LE(offset) === 0x06054b50 && offset + minimumEocd + archive.readUInt16LE(offset + 20) === archive.length) { eocd = offset; break; }
  }
  if (eocd < 0 || archive.readUInt16LE(eocd + 4) !== 0 || archive.readUInt16LE(eocd + 6) !== 0) invalid();
  const entryCount = archive.readUInt16LE(eocd + 10);
  if (entryCount === 0xffff || archive.readUInt16LE(eocd + 8) !== entryCount) invalid();
  let cursor = archive.readUInt32LE(eocd + 16);
  const centralStart = cursor;
  if (cursor + archive.readUInt32LE(eocd + 12) !== eocd) invalid();
  let matched: { method: number; compressed: Buffer; uncompressedSize: number } | null = null;
  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > eocd || archive.readUInt32LE(cursor) !== 0x02014b50) invalid();
    const flags = archive.readUInt16LE(cursor + 8);
    const method = archive.readUInt16LE(cursor + 10);
    const compressedSize = archive.readUInt32LE(cursor + 20);
    const uncompressedSize = archive.readUInt32LE(cursor + 24);
    const nameLength = archive.readUInt16LE(cursor + 28);
    const extraLength = archive.readUInt16LE(cursor + 30);
    const commentLength = archive.readUInt16LE(cursor + 32);
    const localOffset = archive.readUInt32LE(cursor + 42);
    if (cursor + 46 + nameLength + extraLength + commentLength > eocd || archive.readUInt16LE(cursor + 34) !== 0) invalid();
    const name = archive.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");
    if (name === expectedName) {
      if (matched || (flags & 1) !== 0 || ![0, 8].includes(method) || uncompressedSize > maxEntryBytes
        || localOffset + 30 > centralStart || archive.readUInt32LE(localOffset) !== 0x04034b50
        || archive.readUInt16LE(localOffset + 6) !== flags || archive.readUInt16LE(localOffset + 8) !== method) invalid();
      const localNameLength = archive.readUInt16LE(localOffset + 26);
      const localExtraLength = archive.readUInt16LE(localOffset + 28);
      const dataStart = localOffset + 30 + localNameLength + localExtraLength;
      if (dataStart + compressedSize > centralStart || localNameLength !== nameLength
        || archive.subarray(localOffset + 30, localOffset + 30 + localNameLength).toString("utf8") !== expectedName
        || (method === 0 && compressedSize !== uncompressedSize)) invalid();
      // With data descriptors, sizes live in the central directory. Otherwise
      // local and central declarations must agree before any decompression.
      if ((flags & 8) === 0 && (archive.readUInt32LE(localOffset + 18) !== compressedSize
        || archive.readUInt32LE(localOffset + 22) !== uncompressedSize)) invalid();
      matched = { method, compressed: archive.subarray(dataStart, dataStart + compressedSize), uncompressedSize };
    }
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  if (cursor !== eocd) invalid();
  if (!matched) return null;
  let result: Buffer;
  try {
    result = matched.method === 0 ? matched.compressed : inflateRawSync(matched.compressed, { maxOutputLength: maxEntryBytes });
  } catch { invalid(); }
  if (result.length !== matched.uncompressedSize) invalid();
  return result.toString("utf8");
}

async function boundedArtifactBytes(response: Response, maximum: number): Promise<Buffer> {
  const tooLarge = () => new GithubActionsArtifactValidationError("The DeployGuard result artifact response is too large.");
  if (Number(response.headers.get("content-length")) > maximum) {
    await response.body?.cancel().catch(() => undefined);
    throw tooLarge();
  }
  if (!response.body) throw new GithubActionsArtifactValidationError("The DeployGuard result artifact response has no body.");
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) throw new GithubActionsArtifactValidationError("The DeployGuard result artifact response is invalid.");
      length += value.byteLength;
      if (length > maximum) throw tooLarge();
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    // Cancellation failure must not replace the original bounded failure.
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks, length);
}

// actions/upload-artifact preserves the file but strips the uploaded common
// directory, so `path: terraform/deployguard-result.json` is ZIP-rooted.
export const DEPLOYGUARD_RESULT_ARTIFACT_ENTRY = "deployguard-result.json";
export const DEPLOYGUARD_FAILURE_ARTIFACT_ENTRY = "deployguard-failure-evidence.json";

export type GithubActionsWorkflowStage = {
  key: string;
  label: string;
  status: "failed" | "passed" | "running" | "pending" | "skipped" | "unavailable";
  startedAt: string | null;
  completedAt: string | null;
  jobUrl: string | null;
  failureReason: string | null;
};

export type GithubActionsTerminalFailureEvidence = {
  failedStage: string;
  rawEvidence: string;
  workflowStages: GithubActionsWorkflowStage[];
  securityScan?: Record<string, unknown> | null;
  failureEvent?: Record<string, unknown> | null;
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
    workflowRegistrationBranch: string;
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
    if (!operationId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(operationId)) {
      throw new GithubActionsDispatchError("invalid_workflow_inputs", "Dispatch requires a valid immutable deployment operation ID.");
    }
    if (input.inputs && (input.repositoryFullName !== input.inputs.repository_full_name || input.targetBranch !== input.inputs.repository_branch)) {
      const detail = "Dispatch repository and ref do not match the immutable deployment snapshot.";
      throw new GithubActionsDispatchError("invalid_workflow_inputs", detail, this.failureEvidence("invalid_workflow_inputs", null, detail, workflowFile, input.repositoryFullName, input.workflowRegistrationBranch, inputNames, operationId, input.targetBranch));
    }
    await this.validateDispatchTarget(input.repositoryFullName, input.targetBranch, input.workflowRegistrationBranch, workflowFile, token, inputNames, operationId);
    let response: Response;
    const dispatchedAt = new Date();

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
            ref: input.workflowRegistrationBranch,
            ...(input.inputs ? { inputs: dispatchInputs } : {}),
          }),
        }
      );
    } catch {
      throw new GithubActionsDispatchError("unknown_github_error", null, null, true);
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
      throw new GithubActionsDispatchError(diagnosticCode, detail, this.failureEvidence(diagnosticCode, response.status, detail, workflowFile, input.repositoryFullName, input.workflowRegistrationBranch, inputNames, operationId, input.targetBranch));
    }

    // A numeric receipt alone does not prove which operation owns the run.
    // Use the same exact-operation lookup for dispatch and interrupted recovery.
    let workflowRunId: string | null = null;
    try {
      for (let attempt = 0; attempt < 10 && !workflowRunId; attempt += 1) {
        if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 2_000));
        workflowRunId = await this.findWorkflowRunForOperation(
          input.repositoryFullName,
          input.workflowRegistrationBranch,
          operationId,
          dispatchedAt,
          token,
          input.excludedWorkflowRunIds,
        );
      }
      if (!workflowRunId) {
        const detail = "GitHub accepted the workflow request without exposing a unique run for the immutable deployment operation.";
        throw new GithubActionsDispatchError(
          "workflow_run_identity_missing",
          detail,
          this.failureEvidence("workflow_run_identity_missing", response.status, detail, workflowFile, input.repositoryFullName, input.workflowRegistrationBranch, inputNames, operationId, input.targetBranch),
          true,
        );
      }
    } catch (error) {
      // POST already succeeded. Even an unexpected discovery error must not
      // permit compensation of secrets that the accepted workflow may use.
      if (error instanceof GithubActionsDispatchError && error.dispatchMayHaveOccurred) throw error;
      const detail = "GitHub accepted the workflow request, but its immutable workflow run identity could not be verified.";
      throw new GithubActionsDispatchError(
        "workflow_run_identity_missing",
        detail,
        this.failureEvidence("workflow_run_identity_missing", response.status, detail, workflowFile, input.repositoryFullName, input.workflowRegistrationBranch, inputNames, operationId, input.targetBranch),
        true,
      );
    }
    return {
      status: "dispatch_accepted",
      workflowRunId,
      receipt: {
        httpStatus: response.status,
        workflow: workflowFile,
        repository: input.repositoryFullName,
        ref: input.workflowRegistrationBranch,
        sourceRef: input.targetBranch,
        inputNames,
        operationId,
        apiVersion: "2026-03-10",
        authentication: "Bearer installation token",
        workflowRunId,
        workflowRunUrl: `https://github.com/${input.repositoryFullName}/actions/runs/${workflowRunId}`,
      },
    };
  }

  private async validateDispatchTarget(repository: string, sourceBranch: string, registrationBranch: string, workflowFile: string, token: string, inputNames: string[], operationId: string | null) {
    const checks = [
      { url: `https://api.github.com/repos/${repository}`, code: "repo_not_found_or_permission_denied" as const, detail: "GitHub repository is not accessible to the installation token." },
      { url: `https://api.github.com/repos/${repository}/branches/${encodeURIComponent(sourceBranch)}`, code: "wrong_branch" as const, detail: "The selected GitHub source branch does not exist or is not accessible." },
      ...(registrationBranch === sourceBranch ? [] : [{ url: `https://api.github.com/repos/${repository}/branches/${encodeURIComponent(registrationBranch)}`, code: "wrong_branch" as const, detail: "The GitHub workflow-registration branch does not exist or is not accessible." }]),
    ];
    for (const check of checks) {
      const response = await fetch(check.url, { headers: this.headers(token) });
      if (!response.ok) {
        const code = response.status === 401 || response.status === 403 ? "token_no_repo_access" : check.code;
        throw new GithubActionsDispatchError(code, check.detail, this.failureEvidence(code, response.status, check.detail, workflowFile, repository, registrationBranch, inputNames, operationId, sourceBranch));
      }
    }
    const path = workflowFile.includes("/") ? workflowFile : `.github/workflows/${workflowFile}`;
    const response = await fetch(`https://api.github.com/repos/${repository}/contents/${path}?ref=${encodeURIComponent(registrationBranch)}`, { headers: this.headers(token) });
    if (!response.ok) {
      const detail = "The expected workflow file does not exist on the selected branch.";
      throw new GithubActionsDispatchError("workflow_file_missing", detail, this.failureEvidence("workflow_file_missing", response.status, detail, workflowFile, repository, registrationBranch, inputNames, operationId, sourceBranch));
    }
    const body = await response.json() as { content?: string; encoding?: string };
    const content = body.encoding === "base64" && body.content ? Buffer.from(body.content.replace(/\n/g, ""), "base64").toString("utf8") : "";
    if (!/^on:\s*\n\s+workflow_dispatch:\s*$/m.test(content)) {
      const detail = "The expected workflow does not expose workflow_dispatch.";
      throw new GithubActionsDispatchError("workflow_dispatch_missing", detail, this.failureEvidence("workflow_dispatch_missing", null, detail, workflowFile, repository, registrationBranch, inputNames, operationId, sourceBranch));
    }
    const definitions = content.match(/\n    inputs:\n([\s\S]*?)\npermissions:/)?.[1] || "";
    const declared = [...definitions.matchAll(/^\s{6}([a-z][a-z0-9_]*):\s*\{/gm)].map((match) => match[1]).sort();
    const expected = [...RAILPACK_CALLER_INPUT_NAMES].sort();
    const required = expected.filter((name) => !RAILPACK_OPTIONAL_CALLER_INPUT_NAMES.includes(name as typeof RAILPACK_OPTIONAL_CALLER_INPUT_NAMES[number]));
    if (declared.length !== expected.length || declared.some((name, index) => name !== expected[index]) || inputNames.some((name) => !declared.includes(name)) || required.some((name) => !inputNames.includes(name))) {
      const detail = "Generated workflow input names do not match the canonical DeployGuard dispatch contract.";
      throw new GithubActionsDispatchError("invalid_workflow_inputs", detail, this.failureEvidence("invalid_workflow_inputs", null, detail, workflowFile, repository, registrationBranch, inputNames, operationId, sourceBranch));
    }
    const workflowResponse = await fetch(`https://api.github.com/repos/${repository}/actions/workflows/${encodeURIComponent(workflowFile)}`, { headers: this.headers(token) });
    if (!workflowResponse.ok) {
      const code: GithubActionsDiagnosticCode = workflowResponse.status === 401 || workflowResponse.status === 403 ? "token_no_repo_access" : "workflow_file_missing";
      const detail = "GitHub does not expose the expected workflow to the installation token.";
      throw new GithubActionsDispatchError(code, detail, this.failureEvidence(code, workflowResponse.status, detail, workflowFile, repository, registrationBranch, inputNames, operationId, sourceBranch));
    }
    const workflow = await workflowResponse.json() as { state?: string };
    if (workflow.state && workflow.state !== "active") {
      const detail = "The expected GitHub Actions workflow is not active.";
      throw new GithubActionsDispatchError("github_actions_disabled", detail, this.failureEvidence("github_actions_disabled", null, detail, workflowFile, repository, registrationBranch, inputNames, operationId, sourceBranch));
    }
  }

  private failureEvidence(classification: GithubActionsDiagnosticCode, httpStatus: number | null, message: string, workflow: string, repository: string, ref: string, inputNames: string[], operationId: string | null, sourceRef = ref): GithubActionsDispatchEvidence {
    return { classification, httpStatus, message, workflow, repository, ref, sourceRef, inputNames: [...inputNames].sort(), operationId, failedAt: new Date().toISOString() };
  }

  async getWorkflowRun(repositoryFullName: string, workflowRunId: string, token: string) {
    const response = await fetch(`https://api.github.com/repos/${repositoryFullName}/actions/runs/${workflowRunId}`, { headers: this.headers(token) });
    if (!response.ok) throw new GithubActionsDispatchError("unknown_github_error");
    return response.json() as Promise<Record<string, unknown>>;
  }

  async findWorkflowRunForOperation(repository: string, branch: string, operationId: string, dispatchedAt: Date, token: string, excludedIds: string[] = []) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(operationId) || !Number.isFinite(dispatchedAt.getTime())) return null;
    const workflowFile = this.config.get<string>("GITHUB_ACTIONS_WORKFLOW_FILE", "deployguard.yml");
    const floor = dispatchedAt.getTime() - 5_000;
    const expectedTitle = `DeployGuard ${operationId}`;
    const excluded = new Set(excludedIds);
    const matches = new Set<string>();
    const fail = (detail: string) => new GithubActionsDispatchError("workflow_run_identity_missing", detail,
      this.failureEvidence("workflow_run_identity_missing", null, detail, workflowFile, repository, branch, [], operationId), true);
    // Inspect every returned page before accepting uniqueness. A busy workflow
    // or duplicate dispatch must never make page-one's first match authoritative.
    for (let page = 1; page <= 10; page += 1) {
      let response: Response;
      try {
        response = await fetch(`https://api.github.com/repos/${repository}/actions/workflows/${encodeURIComponent(workflowFile)}/runs?event=workflow_dispatch&branch=${encodeURIComponent(branch)}&per_page=100&page=${page}&created=${encodeURIComponent(`>=${new Date(floor).toISOString()}`)}`, { headers: this.headers(token) });
      } catch {
        throw new GithubActionsDispatchError("unknown_github_error", "GitHub workflow-run identity reconciliation is temporarily unavailable.", null, true);
      }
      if (!response.ok) {
        throw new GithubActionsDispatchError("unknown_github_error", "GitHub workflow-run identity reconciliation is temporarily unavailable.", null, true);
      }
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        throw fail("GitHub did not return a valid workflow-run identity listing.");
      }
      if (!body || typeof body !== "object" || Array.isArray(body)) throw fail("GitHub did not return a valid workflow-run identity listing.");
      const listing = body as Record<string, unknown>;
      if (!Array.isArray(listing.workflow_runs)) throw fail("GitHub did not return a valid workflow-run identity listing.");
      const totalCount = listing.total_count;
      if (totalCount !== undefined && (typeof totalCount !== "number" || !Number.isSafeInteger(totalCount) || totalCount < 0)) {
        throw fail("GitHub did not return a valid workflow-run identity listing.");
      }
      // GitHub caps filtered searches at 1,000 results, even when there are more.
      if (typeof totalCount === "number" && totalCount >= 1_000) throw fail("GitHub workflow-run discovery reached the search result limit; unique operation identity is unverified.");
      for (const value of listing.workflow_runs) {
        if (!value || typeof value !== "object" || Array.isArray(value)) throw fail("GitHub did not return a valid workflow-run identity listing.");
        const run = value as Record<string, unknown>;
        const validId = typeof run.id === "string" ? /^[1-9]\d*$/.test(run.id)
          : typeof run.id === "number" && Number.isSafeInteger(run.id) && run.id > 0;
        if (!validId || typeof run.display_title !== "string" || typeof run.created_at !== "string" || !Number.isFinite(Date.parse(run.created_at))
          || (run.event !== undefined && typeof run.event !== "string") || (run.head_branch !== undefined && typeof run.head_branch !== "string")) {
          throw fail("GitHub did not return a valid workflow-run identity listing.");
        }
        const id = String(run.id);
        if (!excluded.has(id) && run.display_title === expectedTitle
          && Date.parse(run.created_at) >= floor
          && (run.event === undefined || run.event === "workflow_dispatch")
          && (run.head_branch === undefined || run.head_branch === branch)) matches.add(id);
      }
      if (matches.size > 1) throw fail("Multiple GitHub workflow runs match the immutable deployment operation; run identity is ambiguous.");
      if (!/<[^>]+>;\s*rel="next"/.test(response.headers.get("link") || "")) return [...matches][0] || null;
    }
    throw fail("GitHub workflow-run discovery exceeded the bounded page limit; unique operation identity is unverified.");
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

  /** Job/step metadata is safe to collect while a run is active. Logs remain
   * terminal-only evidence and are deliberately not read here. */
  async getWorkflowStages(repository: string, workflowRunId: string, token: string, action: GithubActionsPresentationAction = "deploy"): Promise<GithubActionsWorkflowStage[]> {
    const response = await this.getWorkflowJobs(repository, workflowRunId, token);
    const normalized = (value: unknown) => String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
    const stageStatus = (step: { status?: string; conclusion?: string | null }): GithubActionsWorkflowStage["status"] => {
      const conclusion = String(step.conclusion || "").toLowerCase();
      const status = String(step.status || "").toLowerCase();
      if (conclusion === "failure" || conclusion === "cancelled" || conclusion === "timed_out") return "failed";
      if (conclusion === "skipped") return "skipped";
      if (conclusion === "success") return "passed";
      if (["in_progress", "running"].includes(status)) return "running";
      return "pending";
    };
    return (response.jobs || []).flatMap((job) => (job.steps || []).flatMap((step) => {
      const presentation = githubActionsWorkflowStepPresentation(step.name, action);
      if (!presentation) return [];
      return [{
      key: presentation.key,
      label: presentation.label,
      status: stageStatus(step),
      startedAt: step.started_at || null,
      completedAt: step.completed_at || null,
      jobUrl: job.html_url || null,
      failureReason: stageStatus(step) === "failed" ? `GitHub Actions step failed: ${String(step.name || job.name || "workflow bootstrap")}` : null,
      }];
    }));
  }

  /**
   * Collect only bounded evidence for a terminal failure. This deliberately
   * works for bootstrap failures where no deployment artifact exists.
   */
  async getTerminalFailureEvidence(repository: string, workflowRunId: string, operationId: string, token: string, action: GithubActionsPresentationAction = "deploy"): Promise<GithubActionsTerminalFailureEvidence | null> {
    const response = await this.getWorkflowJobs(repository, workflowRunId, token);
    const jobs = response.jobs || [];
    const failed = jobs.find((job) => String(job.conclusion || "").toLowerCase() === "failure")
      || jobs.find((job) => String(job.status || "").toLowerCase() === "completed" && String(job.conclusion || "").toLowerCase() !== "success");
    let persistedFailure: string | null = null;
    let persistedMarkers: string[] = [];
    let securityScan: Record<string, unknown> | null = null;
    let failureEvent: Record<string, unknown> | null = null;
    try {
      const raw = await this.getArtifactEntry(repository, workflowRunId, operationId, token, DEPLOYGUARD_FAILURE_ARTIFACT_ENTRY, 512 * 1024);
      if (raw) {
        const artifact = JSON.parse(raw) as Record<string, unknown>;
        const verification = artifact.awsRuntimeVerification as Record<string, unknown> | null;
        const security = artifact.securityScan as Record<string, unknown> | null;
        const structuredFailure = artifact.failureEvent as Record<string, unknown> | null;
        const services = Array.isArray(verification?.services) ? verification.services as Array<Record<string, unknown>> : [];
        if (artifact.contractVersion === "deployguard.release-failure/v1"
          && artifact.operationId === operationId
          && artifact.action === action
          && verification?.contractVersion === "deployguard.aws-runtime-verification/v1"
          && verification.verified === false
          && services.some((service) => service.verified === false && typeof service.failureMarker === "string" && service.failureMarker.startsWith("DG_FAILURE "))) {
          persistedFailure = JSON.stringify(artifact).slice(-8_000);
          persistedMarkers = services.flatMap((service) => service.verified === false && typeof service.failureMarker === "string" ? [service.failureMarker.slice(0, 500)] : []);
        } else if (artifact.contractVersion === "deployguard.release-failure/v1"
          && artifact.operationId === operationId && artifact.action === action && artifact.failedStage === "trivy_scan"
          && security?.contractVersion === "deployguard.security-result/v1" && security.deploymentOperationId === operationId
          && ["blocked", "error"].includes(String(security.status))) {
          securityScan = security;
          if (structuredFailure?.contractVersion === "deployguard.failure-event/v1" && structuredFailure.operationId === operationId
            && ["DG_TRIVY_POLICY_BLOCKED", "DG_TRIVY_SCAN_FAILED"].includes(String(structuredFailure.code))
            && structuredFailure.stage === "trivy_scan" && structuredFailure.sourceSha === artifact.sourceSha
            && structuredFailure.projectId === security.projectId) failureEvent = structuredFailure;
          persistedFailure = JSON.stringify(artifact).slice(-8_000);
          persistedMarkers = [`DG_FAILURE${failureEvent?.serviceId ? ` serviceId=${failureEvent.serviceId}` : ""} code=${String(failureEvent?.code || (security.status === "blocked" ? "DG_TRIVY_POLICY_BLOCKED" : "DG_TRIVY_SCAN_FAILED"))} stage=trivy_scan`];
        } else if (artifact.contractVersion === "deployguard.release-failure/v1"
          && artifact.operationId === operationId && artifact.action === action
          && structuredFailure?.contractVersion === "deployguard.failure-event/v1"
          && structuredFailure.operationId === operationId
          && structuredFailure.sourceSha === artifact.sourceSha
          && typeof structuredFailure.projectId === "string" && /^[0-9a-f-]{36}$/i.test(structuredFailure.projectId)
          && typeof structuredFailure.code === "string" && /^DG_[A-Z0-9_]+$/.test(structuredFailure.code)
          && typeof structuredFailure.stage === "string" && /^[a-z0-9_]+$/.test(structuredFailure.stage)
          && (structuredFailure.serviceId == null || (typeof structuredFailure.serviceId === "string" && /^[0-9a-f-]{36}$/i.test(structuredFailure.serviceId)))
          && typeof structuredFailure.safeEvidence === "string" && structuredFailure.safeEvidence.length <= 12_000) {
          failureEvent = structuredFailure;
          persistedFailure = JSON.stringify(artifact).slice(-8_000);
          persistedMarkers = [`DG_FAILURE${structuredFailure.serviceId ? ` serviceId=${structuredFailure.serviceId}` : ""} code=${structuredFailure.code} stage=${structuredFailure.stage}`];
        }
      }
    } catch {
      // Failed-workflow job/log metadata remains usable when GitHub has not
      // finished indexing the bounded diagnostic artifact.
    }
    if (!failed && !persistedFailure) return null;
    const failedStep = (failed?.steps || []).find((step) => String(step.conclusion || "").toLowerCase() === "failure");
    const normalized = (value: unknown) => String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
    const failedStage = normalized(failedStep?.name) || normalized(failed?.name) || "workflow_bootstrap";
    const workflowStages = await this.getWorkflowStages(repository, workflowRunId, token, action);
    const summary = [
      `GitHub Actions job: ${String(failed?.name || "workflow bootstrap")}`,
      `Job status: ${String(failed?.status || "completed")}`,
      `Job conclusion: ${String(failed?.conclusion || "failure")}`,
      failedStep ? `Failed step: ${String(failedStep.name || "workflow bootstrap")}` : "Failed before a runnable workflow step was recorded.",
    ];
    if (persistedFailure) summary.push(`Persisted terminal verification evidence: ${persistedFailure}`);
    if (typeof failed?.id === "number") {
      try {
        const log = await this.getJobLog(repository, failed.id, token);
        // Keep the terminal diagnostic area only; sanitation is applied by the
        // caller before persistence.
        summary.push(log.slice(-12_000));
      } catch {
        // Job metadata remains valid bounded evidence when logs are withheld.
      }
    }
    summary.push(...persistedMarkers);
    return { failedStage: typeof failureEvent?.stage === "string" ? failureEvent.stage : failedStage, rawEvidence: summary.join("\n").slice(-16_000), workflowStages, securityScan, failureEvent };
  }

  async getResultArtifact(repository: string, workflowRunId: string, operationId: string, token: string) {
    return this.getArtifactEntry(repository, workflowRunId, operationId, token, DEPLOYGUARD_RESULT_ARTIFACT_ENTRY, 512 * 1024);
  }

  async getArtifactEntry(repository: string, workflowRunId: string, operationId: string, token: string, entryName: string, maxEntryBytes: number) {
    const name = `deployguard-result-${operationId}`;
    const list = await fetch(`https://api.github.com/repos/${repository}/actions/runs/${workflowRunId}/artifacts?name=${encodeURIComponent(name)}&per_page=10`, { headers: this.headers(token), signal: AbortSignal.timeout(30_000) });
    if (!list.ok) {
      await list.body?.cancel().catch(() => undefined);
      throw new GithubActionsDispatchError("unknown_github_error", "GitHub did not expose the DeployGuard result artifact.");
    }
    let body: { artifacts?: Array<{ id?: number; name?: string; expired?: boolean }> };
    try { body = JSON.parse((await boundedArtifactBytes(list, 512 * 1024)).toString("utf8")); }
    catch (error) {
      if (error instanceof SyntaxError) throw new GithubActionsArtifactValidationError("The DeployGuard result artifact listing is malformed.");
      throw error;
    }
    if (!Array.isArray(body?.artifacts) || /<[^>]+>;\s*rel="next"/.test(list.headers.get("link") || "")
      || body.artifacts.some((artifact) => !artifact || typeof artifact.name !== "string" || typeof artifact.expired !== "boolean"
        || !Number.isSafeInteger(artifact.id) || artifact.id < 1)) {
      throw new GithubActionsArtifactValidationError("The DeployGuard result artifact listing is invalid or incomplete.");
    }
    const artifacts = body.artifacts.filter((artifact) => artifact.name === name && artifact.expired === false);
    if (artifacts.length === 0) return null;
    if (artifacts.length !== 1) throw new GithubActionsArtifactValidationError("The DeployGuard result artifact identity is ambiguous.");
    const download = await fetch(`https://api.github.com/repos/${repository}/actions/artifacts/${artifacts[0].id}/zip`, { headers: this.headers(token), redirect: "follow", signal: AbortSignal.timeout(30_000) });
    if (!download.ok) {
      await download.body?.cancel().catch(() => undefined);
      throw new GithubActionsDispatchError("unknown_github_error", "The DeployGuard result artifact could not be downloaded.");
    }
    const maxArchiveBytes = Math.min(Math.max(maxEntryBytes * 2, 2 * 1024 * 1024), 32 * 1024 * 1024);
    const archive = await boundedArtifactBytes(download, maxArchiveBytes);
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
