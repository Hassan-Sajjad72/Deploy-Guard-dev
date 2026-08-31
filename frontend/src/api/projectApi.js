import { apiRequest, getApiBaseUrl } from "./client.js";

// AppLayout's navigation and the route page mount together. Share only an
// in-flight snapshot so the initial browser waterfall has one current-state
// read without ever caching stale deployment status.
const currentStateRequests = new Map();
const detailedCurrentStateRequests = new Map();

export function getProjects() {
  return apiRequest("/api/projects");
}

export function getWorkspaceSummary(history = {}) {
  const params = new URLSearchParams();
  const keys = ["historyState", "historyProject", "historyFrom", "historyTo", "historyLimit", "historyCursor"];
  for (const key of keys) {
    if (typeof history[key] === "string" && history[key]) params.set(key, history[key]);
  }
  const query = params.toString();
  return apiRequest(`/api/projects/workspace-summary${query ? `?${query}` : ""}`);
}

export function recordProjectView(projectId, route, section) {
  return apiRequest(`/api/projects/${encodeURIComponent(projectId)}/activity/view`, {
    method: "POST",
    body: { route, ...(section ? { section } : {}) },
  });
}

export function getGithubRepositories() {
  return apiRequest("/api/projects/github/repositories");
}

export function getGithubConnectionStatus() {
  return apiRequest("/api/projects/github/status");
}

export function connectGithubAppInstallation(installationId) {
  return apiRequest(`/api/projects/github/installations/${encodeURIComponent(installationId)}/connect`, { method: "POST" });
}

export function inspectGithubRepository(repositoryFullName) {
  const [owner, repository] = repositoryFullName.split("/");
  return apiRequest(`/api/projects/github/repositories/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}`);
}

export function getGithubRepositoryBranches(repositoryFullName) {
  const [owner, repository] = repositoryFullName.split("/");
  return apiRequest(`/api/projects/github/repositories/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/branches`);
}

export function getGithubRepositoryDirectories(repositoryFullName, ref) {
  const [owner, repository] = repositoryFullName.split("/");
  return apiRequest(`/api/projects/github/repositories/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/directories?ref=${encodeURIComponent(ref)}`);
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
  const key = String(projectId);
  const existing = currentStateRequests.get(key);
  if (existing) return existing;
  const request = apiRequest(
    `/api/projects/${encodeURIComponent(projectId)}/current-state`,
    { cache: "no-store" }
  );
  currentStateRequests.set(key, request);
  request.then(
    () => { if (currentStateRequests.get(key) === request) currentStateRequests.delete(key); },
    () => { if (currentStateRequests.get(key) === request) currentStateRequests.delete(key); },
  );
  return request;
}

export function getProjectDetailedCurrentState(projectId) {
  const key = String(projectId);
  const existing = detailedCurrentStateRequests.get(key);
  if (existing) return existing;
  const request = apiRequest(
    `/api/projects/${encodeURIComponent(projectId)}/current-state/details`
  );
  detailedCurrentStateRequests.set(key, request);
  request.then(
    () => { if (detailedCurrentStateRequests.get(key) === request) detailedCurrentStateRequests.delete(key); },
    () => { if (detailedCurrentStateRequests.get(key) === request) detailedCurrentStateRequests.delete(key); },
  );
  return request;
}

export function deployGithubActionsDeployment(projectId) {
  return apiRequest(`/api/projects/${encodeURIComponent(projectId)}/deploy`, {
    method: "POST",
  });
}

export function getGithubActionsDeploymentStatus(projectId) {
  return apiRequest(`/api/projects/${encodeURIComponent(projectId)}/deploy/status`);
}

export function getGithubActionsDeploymentHistory(projectId) {
  return apiRequest(`/api/projects/${encodeURIComponent(projectId)}/deploy/history`, { cache: "no-store" });
}

export function retryGithubActionsDeployment(projectId) {
  return apiRequest(`/api/projects/${encodeURIComponent(projectId)}/deploy/retry`, { method: "POST" });
}

export function resetAndDeployFresh(projectId, confirmationPhrase) {
  return apiRequest(`/api/projects/${encodeURIComponent(projectId)}/deploy/reset-fresh`, {
    method: "POST",
    body: { confirmationPhrase },
  });
}

export function getGithubActionsRollbackCandidates(projectId) {
  return apiRequest(`/api/projects/${encodeURIComponent(projectId)}/deploy/rollback-candidates`, { cache: "no-store" });
}

export function rollbackGithubActionsDeployment(projectId, targetOperationId) {
  return apiRequest(`/api/projects/${encodeURIComponent(projectId)}/deploy/rollback`, {
    method: "POST",
    body: { targetOperationId },
  });
}

export function destroyGithubActionsDeployment(projectId, confirmationPhrase) {
  return apiRequest(`/api/projects/${encodeURIComponent(projectId)}/deploy/destroy`, { method: "POST", body: { confirmationPhrase } });
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

export function getProjectServices(projectId) { return apiRequest(`/api/projects/${encodeURIComponent(projectId)}/services`); }
export function createProjectService(projectId, service) { return apiRequest(`/api/projects/${encodeURIComponent(projectId)}/services`, { method: "POST", body: service }); }
export function updateProjectService(projectId, serviceId, service) { return apiRequest(`/api/projects/${encodeURIComponent(projectId)}/services/${encodeURIComponent(serviceId)}`, { method: "PATCH", body: service }); }
export function deleteProjectService(projectId, serviceId) { return apiRequest(`/api/projects/${encodeURIComponent(projectId)}/services/${encodeURIComponent(serviceId)}`, { method: "DELETE" }); }
export function getProjectServiceEnvVars(projectId, serviceId) { return apiRequest(`/api/projects/${encodeURIComponent(projectId)}/services/${encodeURIComponent(serviceId)}/env`); }
export function createProjectServiceEnvVar(projectId, serviceId, data) { return apiRequest(`/api/projects/${encodeURIComponent(projectId)}/services/${encodeURIComponent(serviceId)}/env`, { method: "POST", body: data }); }
export function bulkUpsertProjectServiceEnvVars(projectId, serviceId, variables) { return apiRequest(`/api/projects/${encodeURIComponent(projectId)}/services/${encodeURIComponent(serviceId)}/env/bulk`, { method: "POST", body: { variables } }); }
export function updateProjectServiceEnvVar(projectId, serviceId, envId, data) { return apiRequest(`/api/projects/${encodeURIComponent(projectId)}/services/${encodeURIComponent(serviceId)}/env/${encodeURIComponent(envId)}`, { method: "PATCH", body: data }); }
export function deleteProjectServiceEnvVar(projectId, serviceId, envId) { return apiRequest(`/api/projects/${encodeURIComponent(projectId)}/services/${encodeURIComponent(serviceId)}/env/${encodeURIComponent(envId)}`, { method: "DELETE" }); }

export function createProjectEnvVar(projectId, data) {
  return apiRequest(`/api/projects/${encodeURIComponent(projectId)}/env`, {
    method: "POST",
    body: data,
  });
}

export function bulkUpsertProjectEnvVars(projectId, variables) {
  return apiRequest(`/api/projects/${encodeURIComponent(projectId)}/env/bulk`, {
    method: "POST",
    body: { variables },
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

export function getTerraformStateSafetySnapshot(projectId) {
  return apiRequest(`/api/projects/${encodeURIComponent(projectId)}/state/safety-snapshot`);
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

export function getApplicationRuntimeMetrics(projectId, options = {}) {
  const params = new URLSearchParams();
  if (options.range) params.set("range", options.range);
  if (options.serviceId) params.set("serviceId", options.serviceId);
  const query = params.toString();
  return apiRequest(
    `/api/projects/${encodeURIComponent(projectId)}/observability/application-metrics${query ? `?${query}` : ""}`
  );
}

export function getApplicationLogs(projectId, options = {}) {
  const params = new URLSearchParams();
  if (options.limit) params.set("limit", options.limit);
  if (options.since) params.set("since", options.since);
  if (options.serviceId) params.set("serviceId", options.serviceId);
  const query = params.toString();
  return apiRequest(
    `/api/projects/${encodeURIComponent(projectId)}/observability/application-logs${query ? `?${query}` : ""}`
  );
}

export function getApplicationLogStreamUrl(projectId, serviceId) {
  const query = serviceId ? `?serviceId=${encodeURIComponent(serviceId)}` : "";
  return `${getApiBaseUrl()}/api/projects/${encodeURIComponent(projectId)}/observability/application-logs/stream${query}`;
}

export function getObservabilityHealth(projectId) {
  return apiRequest(`/api/projects/${encodeURIComponent(projectId)}/observability/health`);
}

export function forceReleaseTerraformLock(projectId, lockId) {
  return apiRequest(
    `/api/projects/${encodeURIComponent(projectId)}/state/locks/${encodeURIComponent(lockId)}/force-release`,
    { method: "POST" }
  );
}

export function clearStaleTerraformLockfile(projectId) {
  return apiRequest(
    `/api/projects/${encodeURIComponent(projectId)}/state/lockfile/clear-stale`,
    { method: "POST" }
  );
}

export function getProjectDatabaseTier(projectId) {
  return apiRequest(`/api/projects/${encodeURIComponent(projectId)}/database-tier`);
}

export function updateProjectDatabaseTier(projectId, data) {
  return apiRequest(`/api/projects/${encodeURIComponent(projectId)}/database-tier`, { method: "PATCH", body: data });
}
