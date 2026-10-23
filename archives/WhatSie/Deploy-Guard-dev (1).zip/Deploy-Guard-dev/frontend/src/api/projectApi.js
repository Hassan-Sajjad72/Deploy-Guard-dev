import { apiRequest } from "./client.js";

export function getProjects() {
  return apiRequest("/api/projects");
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

export function getDevOpsTemplates() {
  return apiRequest("/api/templates");
}
