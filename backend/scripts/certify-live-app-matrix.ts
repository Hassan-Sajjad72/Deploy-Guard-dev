import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

type EnvironmentValue = string | {
  value: string;
  isSecret?: boolean;
  scope?: "build" | "runtime" | "both";
};

type MatrixEntry = {
  name: string;
  projectId?: string;
  repository: string;
  branch?: string;
  environmentName?: string;
  serviceName?: string;
  serviceDirectory?: string;
  env?: Record<string, EnvironmentValue>;
};

type Project = {
  id: string;
  name: string;
  repositoryFullName: string;
  targetBranch: string;
  environmentName: string;
  applicationEntryPointServiceId: string | null;
  services: Array<{
    id: string;
    name: string;
    serviceDirectory: string;
    servicePort: number | null;
  }>;
};

type CurrentState = {
  developerState?: string;
  developerMessage?: string;
  stableUrl?: string | null;
  applicationError?: { category?: string; message?: string } | null;
  latestAttempt?: {
    operationId?: string | null;
    generationId?: string | null;
    operationType?: "deploy" | "destroy" | "rollback";
    outcome?: "completed" | "cancelled" | "blocked" | null;
    startedAt?: string | null;
    completedAt?: string | null;
    failureOwner?: string | null;
    workflowStages?: Array<{ key?: string; status?: string }>;
  } | null;
  stableRelease?: {
    id?: string | null;
    operationId?: string | null;
    generationId?: string | null;
  } | null;
};

type FailureEvidence = {
  category: string | null;
  message: string;
  failedStage: string | null;
};

type AppResult = {
  name: string;
  status: "PASS" | "FAIL";
  projectId: string | null;
  projectSource: "created" | "existing" | null;
  deployment: {
    status: "LIVE" | "FAILED" | "TIMEOUT" | "NOT_STARTED";
    durationMs: number | null;
    operationId: string | null;
    generationId: string | null;
    releaseId: string | null;
    publicUrl: string | null;
    reachable: boolean | null;
    failureOwner: string | null;
    failureEvidence: FailureEvidence | null;
  };
  destroy: {
    requested: boolean;
    status: "DESTROYED" | "FAILED" | "TIMEOUT" | "SKIPPED";
    operationId: string | null;
  };
  error: string | null;
};

type RunnerOptions = {
  matrixPath: string;
  apiUrl: string;
  concurrency: number;
  timeoutMs: number;
  pollIntervalMs: number;
  requestTimeoutMs: number;
  destroy: boolean;
  destroyExisting: boolean;
  outputPath: string;
  sessionToken?: string;
  userId?: string;
};

type PreparedApp = { entry: MatrixEntry; project: Project; source: "created" | "existing" };

const TRANSIENT_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);
const SECRET_KEY = /(TOKEN|SECRET|PASSWORD|PASSWD|PRIVATE_KEY|API_KEY|ACCESS_KEY|SESSION|COOKIE)/i;

function sanitizeText(value: unknown): string {
  return String(value || "Unknown certification failure")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(/(deploy_guard_session|cookie|authorization)\s*[=:]\s*[^\s,;]+/gi, "$1=[REDACTED]")
    .replace(/([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|PRIVATE_KEY|API_KEY|ACCESS_KEY)[A-Z0-9_]*)\s*[=:]\s*[^\s,;]+/gi, "$1=[REDACTED]")
    .replace(/\b[A-Za-z0-9+/=_-]{80,}\b/g, "[REDACTED]")
    .slice(0, 500);
}

function repositoryFullName(repository: string): string {
  const trimmed = String(repository || "").trim().replace(/\/$/, "").replace(/\.git$/, "");
  const match = trimmed.match(/^(?:https:\/\/github\.com\/)?([^/\s]+\/[^/\s]+)$/i);
  if (!match) throw new Error("repository must be owner/repository or an https://github.com/owner/repository URL");
  return match[1];
}

function validateMatrix(value: unknown): MatrixEntry[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error("matrix must be a non-empty JSON array");
  const identities = new Set<string>();
  return value.map((raw, index) => {
    if (!raw || typeof raw !== "object") throw new Error(`matrix[${index}] must be an object`);
    const entry = raw as MatrixEntry;
    if (!String(entry.name || "").trim()) throw new Error(`matrix[${index}].name is required`);
    const repository = repositoryFullName(entry.repository);
    const branch = String(entry.branch || "main").trim();
    const environmentName = String(entry.environmentName || "dev").trim();
    const serviceDirectory = String(entry.serviceDirectory || ".").trim();
    if (!branch) throw new Error(`matrix[${index}].branch is required`);
    if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(environmentName)) throw new Error(`matrix[${index}].environmentName is invalid`);
    if (!serviceDirectory || serviceDirectory.startsWith("/") || serviceDirectory.split("/").includes("..")) throw new Error(`matrix[${index}].serviceDirectory is invalid`);
    if (entry.env && (typeof entry.env !== "object" || Array.isArray(entry.env))) throw new Error(`matrix[${index}].env must be an object`);
    for (const [key, envValue] of Object.entries(entry.env || {})) {
      if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) throw new Error(`matrix[${index}].env contains invalid key ${key}`);
      const resolved = typeof envValue === "string" ? envValue : envValue?.value;
      if (typeof resolved !== "string" || !resolved.trim()) throw new Error(`matrix[${index}].env.${key} must have a non-empty value`);
    }
    const identity = entry.projectId || `${repository.toLowerCase()}:${branch}:${environmentName}`;
    if (identities.has(identity)) throw new Error(`matrix contains duplicate project identity ${identity}`);
    identities.add(identity);
    return { ...entry, name: entry.name.trim(), repository, branch, environmentName, serviceDirectory };
  });
}

class ApiClient {
  constructor(private readonly options: RunnerOptions) {}

  async request<T>(method: string, path: string, body?: unknown, transientRetries = 0): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= transientRetries; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.options.requestTimeoutMs);
      try {
        const headers: Record<string, string> = { Accept: "application/json" };
        if (body !== undefined) headers["Content-Type"] = "application/json";
        if (this.options.sessionToken) headers.Cookie = `deploy_guard_session=${this.options.sessionToken}`;
        if (this.options.userId) headers["X-User-Id"] = this.options.userId;
        const response = await fetch(`${this.options.apiUrl}${path}`, {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: controller.signal,
        });
        const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
        if (!response.ok) {
          const error = new Error(sanitizeText(payload.message || payload.error || `HTTP ${response.status}`));
          (error as Error & { status?: number; payload?: Record<string, unknown> }).status = response.status;
          (error as Error & { status?: number; payload?: Record<string, unknown> }).payload = payload;
          throw error;
        }
        return payload as T;
      } catch (error) {
        lastError = error;
        const status = (error as { status?: number }).status;
        const transient = status ? TRANSIENT_STATUSES.has(status) : (error as Error)?.name === "AbortError" || error instanceof TypeError;
        if (!transient || attempt === transientRetries) throw error;
        await delay(Math.min(250 * (2 ** attempt), 2_000));
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastError;
  }
}

function delay(ms: number) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

async function mapLimit<T, R>(values: T[], concurrency: number, worker: (value: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(values.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (true) {
      const index = next++;
      if (index >= values.length) return;
      results[index] = await worker(values[index], index);
    }
  }));
  return results;
}

function emptyResult(name: string): AppResult {
  return {
    name,
    status: "FAIL",
    projectId: null,
    projectSource: null,
    deployment: {
      status: "NOT_STARTED", durationMs: null, operationId: null, generationId: null,
      releaseId: null, publicUrl: null, reachable: null, failureOwner: null, failureEvidence: null,
    },
    destroy: { requested: false, status: "SKIPPED", operationId: null },
    error: null,
  };
}

function findService(project: Project, entry: MatrixEntry) {
  return project.services.find((service) => service.id === project.applicationEntryPointServiceId)
    || project.services.find((service) => service.serviceDirectory === entry.serviceDirectory)
    || (project.services.length === 1 ? project.services[0] : null);
}

function validateExistingProject(project: Project, entry: MatrixEntry) {
  const service = findService(project, entry);
  if (!service) throw new Error("existing project has no unambiguous application service");
  if (service.serviceDirectory !== entry.serviceDirectory) {
    throw new Error(`existing service configuration differs from matrix (directory=${service.serviceDirectory})`);
  }
  return service;
}

async function prepareApps(entries: MatrixEntry[], api: ApiClient): Promise<Array<PreparedApp | AppResult>> {
  const listed = await api.request<{ projects: Project[] }>("GET", "/api/projects");
  const projects = [...(listed.projects || [])];
  const prepared: Array<PreparedApp | AppResult> = [];
  const resolvedIds = new Set<string>();
  for (const entry of entries) {
    const failed = emptyResult(entry.name);
    try {
      let project = entry.projectId
        ? projects.find((candidate) => candidate.id === entry.projectId)
        : projects.find((candidate) => candidate.repositoryFullName.toLowerCase() === entry.repository.toLowerCase()
          && candidate.targetBranch === entry.branch && candidate.environmentName === entry.environmentName);
      let source: "created" | "existing" = "existing";
      if (!project && entry.projectId) throw new Error(`projectId ${entry.projectId} is not accessible`);
      if (!project) {
        const serviceId = randomUUID();
        const created = await api.request<{ project: Project }>("POST", "/api/projects", {
          name: entry.name,
          repositoryFullName: entry.repository,
          targetBranch: entry.branch,
          environmentName: entry.environmentName,
          services: [{ id: serviceId, name: entry.serviceName || entry.name, serviceDirectory: entry.serviceDirectory }],
          applicationEntryPointServiceId: serviceId,
        });
        project = created.project;
        projects.push(project);
        source = "created";
      }
      if (resolvedIds.has(project.id)) throw new Error(`project ${project.id} is referenced more than once`);
      resolvedIds.add(project.id);
      const service = validateExistingProject(project, entry);
      const variables = Object.entries(entry.env || {}).map(([key, raw]) => {
        const value = typeof raw === "string" ? raw : raw.value;
        return {
          key, value,
          isSecret: typeof raw === "string" ? SECRET_KEY.test(key) : raw.isSecret ?? SECRET_KEY.test(key),
          scope: typeof raw === "string" ? "runtime" : raw.scope || "runtime",
        };
      });
      if (variables.length) {
        await api.request("POST", `/api/projects/${project.id}/services/${service.id}/env/bulk`, { variables });
      }
      prepared.push({ entry, project, source });
    } catch (error) {
      failed.error = sanitizeText((error as Error).message);
      prepared.push(failed);
    }
  }
  return prepared;
}

async function pollOperation(api: ApiClient, projectId: string, operationId: string, type: "deploy" | "destroy", options: RunnerOptions): Promise<CurrentState> {
  const deadline = Date.now() + options.timeoutMs;
  while (Date.now() < deadline) {
    const state = await api.request<CurrentState>("GET", `/api/projects/${projectId}/current-state`, undefined, 3);
    const attempt = state.latestAttempt;
    if (attempt?.operationId === operationId && attempt.operationType === type) {
      if (attempt.outcome === "blocked" || attempt.outcome === "cancelled") return state;
      if (type === "deploy" && attempt.outcome === "completed" && state.developerState === "live") return state;
      if (type === "destroy" && attempt.outcome === "completed" && state.developerState === "destroyed") return state;
    }
    await delay(options.pollIntervalMs);
  }
  throw Object.assign(new Error(`${type} polling timed out`), { timeout: true });
}

function operationIdFromAdmission(payload: unknown): string {
  const value = payload as { deployment?: { state?: string; message?: string; operation?: { id?: string } } };
  if (value.deployment?.state !== "accepted" || !value.deployment.operation?.id) {
    throw new Error(value.deployment?.message || "lifecycle operation was not accepted");
  }
  return value.deployment.operation.id;
}

function failureEvidence(state: CurrentState): FailureEvidence {
  const failedStage = state.latestAttempt?.workflowStages?.find((stage) => stage.status === "failed")?.key || null;
  return {
    category: state.applicationError?.category || null,
    message: sanitizeText(state.applicationError?.message || state.developerMessage || "Deployment failed"),
    failedStage,
  };
}

function durationMs(state: CurrentState, fallback: number) {
  const started = Date.parse(String(state.latestAttempt?.startedAt || ""));
  const completed = Date.parse(String(state.latestAttempt?.completedAt || ""));
  return Number.isFinite(started) && Number.isFinite(completed) && completed >= started ? completed - started : fallback;
}

function safePublicUrl(url: string): string | null {
  const parsed = new URL(url);
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) return null;
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
}

async function verifyPublicUrl(url: string, timeoutMs: number): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { method: "GET", redirect: "follow", signal: controller.signal });
    return response.status >= 200 && response.status < 400;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function deployOne(prepared: PreparedApp, api: ApiClient, options: RunnerOptions): Promise<AppResult> {
  const result = emptyResult(prepared.entry.name);
  result.projectId = prepared.project.id;
  result.projectSource = prepared.source;
  const startedAt = Date.now();
  try {
    const admission = await api.request("POST", `/api/projects/${prepared.project.id}/deploy`);
    const operationId = operationIdFromAdmission(admission);
    result.deployment.operationId = operationId;
    const state = await pollOperation(api, prepared.project.id, operationId, "deploy", options);
    result.deployment.durationMs = durationMs(state, Date.now() - startedAt);
    result.deployment.generationId = state.latestAttempt?.generationId || state.stableRelease?.generationId || null;
    result.deployment.failureOwner = state.latestAttempt?.failureOwner || null;
    if (state.latestAttempt?.outcome !== "completed" || state.developerState !== "live" || state.stableRelease?.operationId !== operationId) {
      result.deployment.status = "FAILED";
      result.deployment.failureEvidence = failureEvidence(state);
      return result;
    }
    result.deployment.releaseId = state.stableRelease.id || null;
    result.deployment.publicUrl = state.stableUrl ? safePublicUrl(state.stableUrl) : null;
    result.deployment.reachable = Boolean(result.deployment.publicUrl)
      && await verifyPublicUrl(result.deployment.publicUrl!, options.requestTimeoutMs);
    result.deployment.status = "LIVE";
    if (!result.deployment.reachable) {
      result.error = state.stableUrl ? "public URL was not reachable" : "LIVE state did not include a public URL";
      return result;
    }
    result.status = "PASS";
    return result;
  } catch (error) {
    result.deployment.status = (error as { timeout?: boolean }).timeout ? "TIMEOUT" : "FAILED";
    result.deployment.durationMs = Date.now() - startedAt;
    result.error = sanitizeText((error as Error).message);
    return result;
  }
}

async function destroyOne(result: AppResult, api: ApiClient, options: RunnerOptions): Promise<void> {
  result.destroy.requested = true;
  try {
    const admission = await api.request("POST", `/api/projects/${result.projectId}/deploy/destroy`, { confirmationPhrase: "DESTROY" });
    const operationId = operationIdFromAdmission(admission);
    result.destroy.operationId = operationId;
    const state = await pollOperation(api, result.projectId!, operationId, "destroy", options);
    if (state.latestAttempt?.outcome === "completed" && state.developerState === "destroyed") {
      result.destroy.status = "DESTROYED";
      return;
    }
    result.destroy.status = "FAILED";
    result.status = "FAIL";
    result.error = sanitizeText(state.latestAttempt?.failureOwner
      ? `Destroy failed (${state.latestAttempt.failureOwner}): ${state.developerMessage || "no verified deletion evidence"}`
      : state.developerMessage || "Destroy failed without verified deletion evidence");
  } catch (error) {
    result.destroy.status = (error as { timeout?: boolean }).timeout ? "TIMEOUT" : "FAILED";
    result.status = "FAIL";
    result.error = sanitizeText((error as Error).message);
  }
}

function printTable(results: AppResult[]) {
  const rows = results.map((result) => ({
    APP: result.name,
    RESULT: result.status,
    DEPLOY: result.deployment.status,
    DURATION: result.deployment.durationMs === null ? "-" : `${(result.deployment.durationMs / 1000).toFixed(1)}s`,
    URL: result.deployment.reachable === null ? "-" : result.deployment.reachable ? "PASS" : "FAIL",
    DESTROY: result.destroy.status,
    OWNER: result.deployment.failureOwner || "-",
  }));
  console.table(rows);
}

export async function runCertification(options: RunnerOptions) {
  const entries = validateMatrix(JSON.parse(readFileSync(options.matrixPath, "utf8")));
  const api = new ApiClient(options);
  const prepared = await prepareApps(entries, api);
  const results = await mapLimit(prepared, options.concurrency, async (item) => {
    if ("status" in item) return item;
    return deployOne(item, api, options);
  });
  if (options.destroy) {
    const successful = results.filter((result) => result.status === "PASS"
      && (result.projectSource === "created" || options.destroyExisting));
    await mapLimit(successful, options.concurrency, (result) => destroyOne(result, api, options));
  }
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    apiUrl: options.apiUrl,
    matrix: resolve(options.matrixPath),
    concurrency: options.concurrency,
    destroyRequested: options.destroy,
    destroyExistingRequested: options.destroyExisting,
    summary: {
      total: results.length,
      passed: results.filter((result) => result.status === "PASS").length,
      failed: results.filter((result) => result.status === "FAIL").length,
    },
    results,
  };
  writeFileSync(options.outputPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  printTable(results);
  console.log(`JSON_REPORT=${resolve(options.outputPath)}`);
  return report;
}

function positiveInteger(value: string | undefined, flag: string, fallback: number) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${flag} must be a positive integer`);
  return parsed;
}

function parseCli(argv: string[]): RunnerOptions {
  const values = new Map<string, string>();
  let destroy = false;
  let destroyExisting = false;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--destroy") { destroy = true; continue; }
    if (flag === "--destroy-existing") { destroyExisting = true; continue; }
    if (!["--matrix", "--api-url", "--concurrency", "--timeout-seconds", "--poll-interval-ms", "--request-timeout-ms", "--output"].includes(flag)) {
      throw new Error(`Unknown argument: ${flag}`);
    }
    const value = argv[++index];
    if (!value) throw new Error(`${flag} requires a value`);
    values.set(flag, value);
  }
  const matrix = values.get("--matrix");
  if (!matrix) throw new Error("--matrix is required");
  const sessionToken = process.env.DEPLOYGUARD_SESSION_TOKEN?.trim();
  const userId = process.env.DEPLOYGUARD_USER_ID?.trim();
  if (!sessionToken && !userId) throw new Error("Set DEPLOYGUARD_SESSION_TOKEN, or DEPLOYGUARD_USER_ID for an explicitly enabled non-production test server");
  if (destroyExisting && !destroy) throw new Error("--destroy-existing requires --destroy");
  const apiUrl = new URL(String(values.get("--api-url") || process.env.DEPLOYGUARD_API_URL || "http://127.0.0.1:3000"));
  if (!["http:", "https:"].includes(apiUrl.protocol) || apiUrl.username || apiUrl.password || apiUrl.search || apiUrl.hash) {
    throw new Error("--api-url must be an HTTP(S) origin without credentials, query, or fragment");
  }
  return {
    matrixPath: resolve(matrix),
    apiUrl: apiUrl.toString().replace(/\/$/, ""),
    concurrency: positiveInteger(values.get("--concurrency"), "--concurrency", 5),
    timeoutMs: positiveInteger(values.get("--timeout-seconds"), "--timeout-seconds", 45 * 60) * 1_000,
    pollIntervalMs: positiveInteger(values.get("--poll-interval-ms"), "--poll-interval-ms", 10_000),
    requestTimeoutMs: positiveInteger(values.get("--request-timeout-ms"), "--request-timeout-ms", 15_000),
    destroy,
    destroyExisting,
    outputPath: resolve(values.get("--output") || "certification-report.json"),
    sessionToken,
    userId,
  };
}

if (require.main === module) {
  void runCertification(parseCli(process.argv.slice(2)))
    .then((report) => { process.exitCode = report.summary.failed > 0 ? 1 : 0; })
    .catch((error) => {
      console.error(`CERTIFICATION_RUNNER_ERROR=${sanitizeText((error as Error).message)}`);
      process.exitCode = 2;
    });
}
