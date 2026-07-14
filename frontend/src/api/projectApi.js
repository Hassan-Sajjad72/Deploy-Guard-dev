import { apiRequest, getApiBaseUrl } from "./client.js";

export function getProjects() {
  return apiRequest("/api/projects");
}

export function getWorkspaceSummary() {
  return apiRequest("/api/projects/workspace-summary");
}

export function getGithubRepositories() {
  return apiRequest("/api/projects/github/repositories");
}

export function getGithubRepositoryBranches(repositoryFullName) {
  const [owner, repository] = repositoryFullName.split("/");
  return apiRequest(`/api/projects/github/repositories/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/branches`);
}

export function createProject(data) {
  return apiRequest("/api/projects", {
    method: "POST",
    body: data,
  });
}

export function getProject(projectId) {
  return apiRequest(`/api/projects/${encodeURIComponent(projectId)}`);
}

export function getProjectCurrentState(projectId) {
  return apiRequest(
    `/api/projects/${encodeURIComponent(projectId)}/current-state`
  );
}

export function startProjectAutomation(projectId) {
  return apiRequest(
    `/api/projects/${encodeURIComponent(projectId)}/automation/start`,
    { method: "POST" }
  );
}

export function updateProject(projectId, data) {
  return apiRequest(`/api/projects/${encodeURIComponent(projectId)}`, {
    method: "PATCH",
    body: data,
  });
}

export function archiveProject(projectId) {
  return apiRequest(`/api/projects/${encodeURIComponent(projectId)}`, {
    method: "DELETE",
  });
}

export function updateProjectRepository(projectId, data) {
  return apiRequest(`/api/projects/${encodeURIComponent(projectId)}/repository`, {
    method: "PATCH",
    body: data,
  });
}

export function getProjectBranches(projectId) {
  return apiRequest(`/api/projects/${encodeURIComponent(projectId)}/branches`);
}

export function updateProjectBranch(projectId, targetBranch) {
  return apiRequest(`/api/projects/${encodeURIComponent(projectId)}/branch`, {
    method: "PATCH",
    body: { targetBranch },
  });
}

export function getProjectEnvVars(projectId) {
  return apiRequest(`/api/projects/${encodeURIComponent(projectId)}/env`);
}

export function createProjectEnvVar(projectId, data) {
  return apiRequest(`/api/projects/${encodeURIComponent(projectId)}/env`, {
    method: "POST",
    body: data,
  });
}

export function updateProjectEnvVar(projectId, envId, data) {
  return apiRequest(
    `/api/projects/${encodeURIComponent(projectId)}/env/${encodeURIComponent(envId)}`,
    {
      method: "PATCH",
      body: data,
    }
  );
}

export function deleteProjectEnvVar(projectId, envId) {
  return apiRequest(
    `/api/projects/${encodeURIComponent(projectId)}/env/${encodeURIComponent(envId)}`,
    {
      method: "DELETE",
    }
  );
}

export function runStackDetection(projectId) {
  return apiRequest(`/api/projects/${encodeURIComponent(projectId)}/detect-stack`, {
    method: "POST",
  });
}

export function getDetectionProfile(projectId) {
  return apiRequest(
    `/api/projects/${encodeURIComponent(projectId)}/detection-profile`
  );
}

export function generatePreflightReport(projectId) {
  return apiRequest(`/api/projects/${encodeURIComponent(projectId)}/preflight`, {
    method: "POST",
  });
}

export function getPreflightReport(projectId) {
  return apiRequest(`/api/projects/${encodeURIComponent(projectId)}/preflight`);
}

export function startPipelineRun(projectId, options) {
  return apiRequest(`/api/projects/${encodeURIComponent(projectId)}/pipeline/runs`, {
    method: "POST",
    body: options,
  });
}

export function getPipelineRuns(projectId) {
  return apiRequest(`/api/projects/${encodeURIComponent(projectId)}/pipeline/runs`);
}

export function getPipelineRun(projectId, runId) {
  return apiRequest(
    `/api/projects/${encodeURIComponent(projectId)}/pipeline/runs/${encodeURIComponent(runId)}`
  );
}

export function getPipelineRunEvents(projectId, runId) {
  return apiRequest(
    `/api/projects/${encodeURIComponent(projectId)}/pipeline/runs/${encodeURIComponent(runId)}/events`
  );
}

export function cancelPipelineRun(projectId, runId) {
  return apiRequest(
    `/api/projects/${encodeURIComponent(projectId)}/pipeline/runs/${encodeURIComponent(runId)}/cancel`,
    { method: "POST" }
  );
}

export function retryPipelineRun(projectId, runId) {
  return apiRequest(
    `/api/projects/${encodeURIComponent(projectId)}/pipeline/runs/${encodeURIComponent(runId)}/retry`,
    { method: "POST" }
  );
}

export function triggerSecurityScan(projectId, data) {
  return apiRequest(`/api/projects/${encodeURIComponent(projectId)}/security-scans`, {
    method: "POST",
    body: data,
  });
}

export function getSecurityScans(projectId) {
  return apiRequest(`/api/projects/${encodeURIComponent(projectId)}/security-scans`);
}

export function getSecurityScan(projectId, scanId) {
  return apiRequest(
    `/api/projects/${encodeURIComponent(projectId)}/security-scans/${encodeURIComponent(scanId)}`
  );
}

export function getSecurityScanFindings(projectId, scanId, filters = {}) {
  const params = new URLSearchParams();

  Object.entries(filters).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") {
      params.set(key, value);
    }
  });

  const query = params.toString();

  return apiRequest(
    `/api/projects/${encodeURIComponent(projectId)}/security-scans/${encodeURIComponent(scanId)}/findings${query ? `?${query}` : ""}`
  );
}

export function approveSecurityScan(projectId, scanId, reason) {
  return apiRequest(
    `/api/projects/${encodeURIComponent(projectId)}/security-scans/${encodeURIComponent(scanId)}/approve`,
    {
      method: "POST",
      body: { reason },
    }
  );
}

export function createCostEstimate(projectId) {
  return apiRequest(`/api/projects/${encodeURIComponent(projectId)}/cost-estimates`, {
    method: "POST",
  });
}

export function getCostEstimates(projectId) {
  return apiRequest(`/api/projects/${encodeURIComponent(projectId)}/cost-estimates`);
}

export function getLatestCostEstimate(projectId) {
  return apiRequest(
    `/api/projects/${encodeURIComponent(projectId)}/cost-estimates/latest`
  );
}

export function getCostEstimate(projectId, estimateId) {
  return apiRequest(
    `/api/projects/${encodeURIComponent(projectId)}/cost-estimates/${encodeURIComponent(estimateId)}`
  );
}

export function approveCostEstimate(projectId, estimateId) {
  return apiRequest(
    `/api/projects/${encodeURIComponent(projectId)}/cost-estimates/${encodeURIComponent(estimateId)}/approve`,
    { method: "POST" }
  );
}

export function rejectCostEstimate(projectId, estimateId, reason) {
  return apiRequest(
    `/api/projects/${encodeURIComponent(projectId)}/cost-estimates/${encodeURIComponent(estimateId)}/reject`,
    {
      method: "POST",
      body: { reason },
    }
  );
}

export function getCostSettings(projectId) {
  return apiRequest(`/api/projects/${encodeURIComponent(projectId)}/cost-settings`);
}

export function updateCostSettings(projectId, data) {
  return apiRequest(`/api/projects/${encodeURIComponent(projectId)}/cost-settings`, {
    method: "PATCH",
    body: data,
  });
}

export function getDeploymentReadiness(projectId) {
  return apiRequest(`/api/projects/${encodeURIComponent(projectId)}/deployment-readiness`);
}

export function deployProject(projectId) {
  return apiRequest(`/api/projects/${encodeURIComponent(projectId)}/deploy`, {
    method: "POST",
  });
}

export function runInfrastructurePlan(projectId) {
  return apiRequest(`/api/projects/${encodeURIComponent(projectId)}/infrastructure/plan`, {
    method: "POST",
  });
}

export function runInfrastructureApply(projectId) {
  return apiRequest(`/api/projects/${encodeURIComponent(projectId)}/infrastructure/apply`, {
    method: "POST",
  });
}

export function getInfrastructure(projectId) {
  return apiRequest(`/api/projects/${encodeURIComponent(projectId)}/infrastructure`);
}

export function getInfrastructureEvents(projectId) {
  return apiRequest(
    `/api/projects/${encodeURIComponent(projectId)}/infrastructure/events`
  );
}

export function getServiceDiscovery(projectId) {
  return apiRequest(`/api/projects/${encodeURIComponent(projectId)}/service-discovery`);
}

export function getTerraformState(projectId) {
  return apiRequest(`/api/projects/${encodeURIComponent(projectId)}/state`);
}

export function getTerraformStateVersions(projectId) {
  return apiRequest(`/api/projects/${encodeURIComponent(projectId)}/state/versions`);
}

export function getTerraformStateLocks(projectId) {
  return apiRequest(`/api/projects/${encodeURIComponent(projectId)}/state/locks`);
}

export function getTerraformStateValidation(projectId) {
  return apiRequest(`/api/projects/${encodeURIComponent(projectId)}/state/validation`);
}

export function validateTerraformState(projectId) {
  return apiRequest(`/api/projects/${encodeURIComponent(projectId)}/state/validate`, {
    method: "POST",
  });
}

export function recoverTerraformState(projectId, versionId, reason) {
  return apiRequest(`/api/projects/${encodeURIComponent(projectId)}/state/recover`, {
    method: "POST",
    body: { versionId, reason },
  });
}

export function getStorageRecommendation(projectId) {
  return apiRequest(
    `/api/projects/${encodeURIComponent(projectId)}/storage/recommendation`
  );
}

export function getProjectStorage(projectId) {
  return apiRequest(`/api/projects/${encodeURIComponent(projectId)}/storage`);
}

export function updateStorageSettings(projectId, data) {
  return apiRequest(`/api/projects/${encodeURIComponent(projectId)}/storage/settings`, {
    method: "PATCH",
    body: data,
  });
}

export function provisionStorage(projectId) {
  return apiRequest(`/api/projects/${encodeURIComponent(projectId)}/storage/provision`, {
    method: "POST",
  });
}

export function getStorageEvents(projectId) {
  return apiRequest(`/api/projects/${encodeURIComponent(projectId)}/storage/events`);
}

export function getStorageMountConfig(projectId) {
  return apiRequest(
    `/api/projects/${encodeURIComponent(projectId)}/storage/mount-config`
  );
}

export function getBackups(projectId) {
  return apiRequest(`/api/projects/${encodeURIComponent(projectId)}/backups`);
}

export function requestBackupRestore(projectId, data) {
  return apiRequest(
    `/api/projects/${encodeURIComponent(projectId)}/backups/restore-request`,
    {
      method: "POST",
      body: data,
    }
  );
}

export function deployOrchestration(projectId) {
  return apiRequest(`/api/projects/${encodeURIComponent(projectId)}/orchestration/deploy`, {
    method: "POST",
  });
}

export function getOrchestrationStatus(projectId) {
  return apiRequest(`/api/projects/${encodeURIComponent(projectId)}/orchestration/status`);
}

export function getOrchestrationEvents(projectId) {
  return apiRequest(`/api/projects/${encodeURIComponent(projectId)}/orchestration/events`);
}

export function getOrchestrationReleases(projectId) {
  return apiRequest(`/api/projects/${encodeURIComponent(projectId)}/orchestration/releases`);
}

export function rollbackOrchestration(projectId, reason) {
  return apiRequest(`/api/projects/${encodeURIComponent(projectId)}/orchestration/rollback`, {
    method: "POST",
    body: { reason },
  });
}

export function getOrchestrationTargetHealth(projectId) {
  return apiRequest(
    `/api/projects/${encodeURIComponent(projectId)}/orchestration/target-health`
  );
}

export function getOrchestrationScaling(projectId) {
  return apiRequest(`/api/projects/${encodeURIComponent(projectId)}/orchestration/scaling`);
}

export function updateOrchestrationScaling(projectId, data) {
  return apiRequest(`/api/projects/${encodeURIComponent(projectId)}/orchestration/scaling`, {
    method: "PATCH",
    body: data,
  });
}

export function getObservabilitySummary(projectId) {
  return apiRequest(`/api/projects/${encodeURIComponent(projectId)}/observability/summary`);
}

export function getObservabilityPipelineMetrics(projectId, pipelineRunId) {
  const params = new URLSearchParams();
  if (pipelineRunId) params.set("pipelineRunId", pipelineRunId);
  const query = params.toString();
  return apiRequest(
    `/api/projects/${encodeURIComponent(projectId)}/observability/pipeline-metrics${query ? `?${query}` : ""}`
  );
}

export function getObservabilityRuntimeMetrics(projectId, options = {}) {
  const params = new URLSearchParams();
  if (options.source) params.set("source", options.source);
  if (options.range) params.set("range", options.range);
  const query = params.toString();
  return apiRequest(
    `/api/projects/${encodeURIComponent(projectId)}/observability/runtime-metrics${query ? `?${query}` : ""}`
  );
}

export function getObservabilityLogs(projectId, options = {}) {
  const params = new URLSearchParams();
  Object.entries(options).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") params.set(key, value);
  });
  const query = params.toString();
  return apiRequest(
    `/api/projects/${encodeURIComponent(projectId)}/observability/logs${query ? `?${query}` : ""}`
  );
}

export function getObservabilityHealth(projectId) {
  return apiRequest(`/api/projects/${encodeURIComponent(projectId)}/observability/health`);
}

export function getObservabilityLogStreamUrl(projectId, options = {}) {
  const params = new URLSearchParams();
  Object.entries(options).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") params.set(key, value);
  });
  const query = params.toString();
  return `${getApiBaseUrl()}/api/projects/${encodeURIComponent(projectId)}/observability/logs/stream${query ? `?${query}` : ""}`;
}

export function forceReleaseTerraformLock(projectId, lockId) {
  return apiRequest(
    `/api/projects/${encodeURIComponent(projectId)}/state/locks/${encodeURIComponent(lockId)}/force-release`,
    { method: "POST" }
  );
}

export function getDevOpsTemplates() {
  return apiRequest("/api/templates");
}
