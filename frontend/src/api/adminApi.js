import { apiRequest, getApiBaseUrl } from "./client.js";

export function getUsers() {
  return apiRequest("/api/admin/users");
}

export function getAdminOverview() {
  return apiRequest("/api/admin/overview");
}

export function getAdminProjects() {
  return apiRequest("/api/admin/projects");
}

export function getAdminAuditLogs(filters = {}) {
  const params = new URLSearchParams();
  Object.entries(filters).forEach(([key, value]) => {
    if (value !== "" && value !== null && value !== undefined) params.set(key, String(value));
  });
  const query = params.toString();
  return apiRequest(`/api/admin/audit-logs${query ? `?${query}` : ""}`);
}

export function updateUserRole(userId, role) {
  return apiRequest(`/api/admin/users/${encodeURIComponent(userId)}/role`, {
    method: "PATCH",
    body: { role },
  });
}

export function updateUserAccess(userId, enabled) {
  return apiRequest(`/api/admin/users/${encodeURIComponent(userId)}/access`, {
    method: "PATCH",
    body: { enabled },
  });
}

// Central cloud cleanup — thin clients for the existing /api/admin/cloud-cleanup endpoints.
const CLEANUP = "/api/admin/cloud-cleanup";
export const getCloudCleanupSummary = () => apiRequest(`${CLEANUP}/summary`);
export function getCloudCleanupResources(filters = {}) {
  const params = new URLSearchParams();
  Object.entries(filters).forEach(([key, value]) => { if (value !== "" && value !== null && value !== undefined) params.set(key, String(value)); });
  const query = params.toString();
  return apiRequest(`${CLEANUP}/resources${query ? `?${query}` : ""}`);
}
export const refreshCloudCleanupInventory = () => apiRequest(`${CLEANUP}/refresh`, { method: "POST" });
export const createCentralCleanupChallenge = (action) => apiRequest(`${CLEANUP}/challenge`, { method: "POST", body: { action } });
export const cleanupSelectedCloudResources = (body) => apiRequest(`${CLEANUP}/cleanup-selected`, { method: "POST", body });
export const cleanupSafeOrphans = (body) => apiRequest(`${CLEANUP}/cleanup-safe-orphans`, { method: "POST", body });
export const retryCentralProjectDestroy = (projectId, operationId) => apiRequest(`${CLEANUP}/retry-project-destroy`, { method: "POST", body: { projectId, operationId } });
export const markCloudResourcesManualReview = (resourceIds) => apiRequest(`${CLEANUP}/manual-review`, { method: "POST", body: { resourceIds } });
export const markProjectCleanupComplete = (projectId) => apiRequest(`${CLEANUP}/mark-project-complete`, { method: "POST", body: { projectId } });
export const getEmergencyCleanupPreview = () => apiRequest(`${CLEANUP}/emergency/preview`);
export const getEmergencyCleanupOperations = () => apiRequest(`${CLEANUP}/emergency/operations`);
export const createEmergencyCleanupChallenge = () => apiRequest(`${CLEANUP}/emergency/challenge`, { method: "POST" });
export const executeEmergencyCleanup = (body) => apiRequest(`${CLEANUP}/emergency/execute`, { method: "POST", body });
export async function downloadCloudCleanupReport() {
  const response = await fetch(`${getApiBaseUrl()}${CLEANUP}/report`, { credentials: "include" });
  if (!response.ok) { const payload = await response.json().catch(() => ({})); throw new Error(payload.message || "Cleanup report download failed"); }
  const disposition = response.headers.get("content-disposition") || "";
  const filename = /filename="([^"]+)"/.exec(disposition)?.[1] || "deployguard-cloud-cleanup-report.csv";
  const url = URL.createObjectURL(await response.blob());
  const anchor = document.createElement("a"); anchor.href = url; anchor.download = filename; anchor.click(); URL.revokeObjectURL(url);
}
