import { apiRequest, getApiBaseUrl } from "./client.js";

export function getUsers() {
  return apiRequest("/api/admin/users");
}

export function updateUserRole(userId, role) {
  return apiRequest(`/api/admin/users/${encodeURIComponent(userId)}/role`, {
    method: "PATCH",
    body: { role },
  });
}

export const getCloudCleanupSummary = () => apiRequest("/api/admin/cloud-cleanup/summary");
export const getCloudCleanupResources = (filters = {}) => {
  const query = new URLSearchParams(Object.entries(filters).filter(([, value]) => value));
  return apiRequest(`/api/admin/cloud-cleanup/resources${query.size ? `?${query}` : ""}`);
};
export const refreshCloudCleanupInventory = () => apiRequest("/api/admin/cloud-cleanup/refresh", { method: "POST" });
export const createCentralCleanupChallenge = (action) => apiRequest("/api/admin/cloud-cleanup/challenge", { method: "POST", body: { action } });
export const cleanupSelectedCloudResources = (body) => apiRequest("/api/admin/cloud-cleanup/cleanup-selected", { method: "POST", body });
export const cleanupSafeOrphans = (body) => apiRequest("/api/admin/cloud-cleanup/cleanup-safe-orphans", { method: "POST", body });
export const markCloudResourcesManualReview = (resourceIds) => apiRequest("/api/admin/cloud-cleanup/manual-review", { method: "POST", body: { resourceIds } });
export const retryCentralProjectDestroy = (projectId, operationId) => apiRequest("/api/admin/cloud-cleanup/retry-project-destroy", { method: "POST", body: { projectId, operationId } });
export const markProjectCleanupComplete = (projectId) => apiRequest("/api/admin/cloud-cleanup/mark-project-complete", { method: "POST", body: { projectId } });
export const getEmergencyCleanupPreview = () => apiRequest("/api/admin/cloud-cleanup/emergency/preview");
export const getEmergencyCleanupOperations = () => apiRequest("/api/admin/cloud-cleanup/emergency/operations");
export const createEmergencyCleanupChallenge = () => apiRequest("/api/admin/cloud-cleanup/emergency/challenge", { method: "POST" });
export const executeEmergencyCleanup = (body) => apiRequest("/api/admin/cloud-cleanup/emergency/execute", { method: "POST", body });
export async function downloadCloudCleanupReport() {
  const response = await fetch(`${getApiBaseUrl()}/api/admin/cloud-cleanup/report`, { credentials: "include" });
  if (!response.ok) { const payload = await response.json().catch(() => ({})); throw new Error(payload.message || "Cleanup report export failed"); }
  const blob = await response.blob(); const disposition = response.headers.get("content-disposition") || ""; const filename = disposition.match(/filename="?([^";]+)"?/)?.[1] || "deployguard-cloud-cleanup.csv"; const url = URL.createObjectURL(blob); const anchor = document.createElement("a"); anchor.href = url; anchor.download = filename; anchor.click(); URL.revokeObjectURL(url);
}
