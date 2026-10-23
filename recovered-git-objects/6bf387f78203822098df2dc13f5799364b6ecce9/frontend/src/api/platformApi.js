import { apiRequest, getApiBaseUrl } from "./client.js";
const id = encodeURIComponent;
export const getBillingSummary = () => apiRequest("/api/billing/summary");
export const createBillingCheckout = () => apiRequest("/api/billing/checkout", { method: "POST", body: { plan: "pro" } });
export const createBillingPortal = () => apiRequest("/api/billing/portal", { method: "POST" });
export const cancelBilling = () => apiRequest("/api/billing/cancel", { method: "POST" });
export const getTroubleshootingSessions = (projectId) => apiRequest(`/api/projects/${id(projectId)}/troubleshooting`);
export const getTroubleshootingSession = (projectId, sessionId) => apiRequest(`/api/projects/${id(projectId)}/troubleshooting/${id(sessionId)}`);
export const startTroubleshooting = (projectId, pipelineRunId) => apiRequest(`/api/projects/${id(projectId)}/troubleshooting`, { method: "POST", body: { pipelineRunId } });
export const followUpTroubleshooting = (projectId, sessionId, message) => apiRequest(`/api/projects/${id(projectId)}/troubleshooting/${id(sessionId)}/follow-up`, { method: "POST", body: { message } });
export const getNotificationSettings = (projectId) => apiRequest(`/api/projects/${id(projectId)}/notifications`);
export const updateNotificationSettings = (projectId, body) => apiRequest(`/api/projects/${id(projectId)}/notifications/preferences`, { method: "PATCH", body });
export const subscribeNotifications = (projectId) => apiRequest(`/api/projects/${id(projectId)}/notifications/subscribe`, { method: "POST" });
export const testNotification = (projectId) => apiRequest(`/api/projects/${id(projectId)}/notifications/test`, { method: "POST" });
export const getDestroyReview = (projectId) => apiRequest(`/api/projects/${id(projectId)}/infrastructure/destroy/review`);
export const createDestroyChallenge = (projectId, environmentName = "dev") => apiRequest(`/api/projects/${id(projectId)}/infrastructure/destroy/challenge`, { method: "POST", body: { environmentName } });
export const requestDestroy = (projectId, body) => apiRequest(`/api/projects/${id(projectId)}/infrastructure/destroy/request`, { method: "POST", body });
export const getDestroyStatus = (projectId, operationId) => apiRequest(`/api/projects/${id(projectId)}/infrastructure/destroy/status${operationId ? `?operationId=${id(operationId)}` : ""}`);
export const cancelDestroy = (projectId, operationId) => apiRequest(`/api/projects/${id(projectId)}/infrastructure/destroy/${id(operationId)}/cancel`, { method: "POST" });
export const retryDestroy = (projectId, operationId) => apiRequest(`/api/projects/${id(projectId)}/infrastructure/destroy/${id(operationId)}/retry`, { method: "POST" });
export const getProjectCloudInventory = (projectId) => apiRequest(`/api/projects/${id(projectId)}/infrastructure/destroy/inventory`);
export const createCloudCleanupChallenge = (projectId, environmentName = "dev") => apiRequest(`/api/projects/${id(projectId)}/infrastructure/destroy/cleanup/challenge`, { method: "POST", body: { environmentName } });
export const requestCloudCleanup = (projectId, body) => apiRequest(`/api/projects/${id(projectId)}/infrastructure/destroy/cleanup`, { method: "POST", body });
export const getProjectResources = (projectId) => apiRequest(`/api/projects/${id(projectId)}/resources`);
export const refreshProjectResources = (projectId) => apiRequest(`/api/projects/${id(projectId)}/resources/refresh`, { method: "POST" });
export const updateProjectResourceTtl = (projectId, body) => apiRequest(`/api/projects/${id(projectId)}/resources/ttl`, { method: "PATCH", body });
export async function downloadProjectCleanupReport(projectId) { const response = await fetch(`${getApiBaseUrl()}/api/projects/${id(projectId)}/cleanup-report`, { credentials: "include" }); if (!response.ok) { const payload = await response.json().catch(() => ({})); throw new Error(payload.message || "Project cleanup report export failed"); } const blob = await response.blob(); const disposition = response.headers.get("content-disposition") || ""; const filename = disposition.match(/filename="?([^";]+)"?/)?.[1] || `deployguard-${id(projectId)}-resources.csv`; const url = URL.createObjectURL(blob); const anchor = document.createElement("a"); anchor.href = url; anchor.download = filename; anchor.click(); URL.revokeObjectURL(url); }
export const createTerraformExport = (projectId) => apiRequest(`/api/projects/${id(projectId)}/infrastructure/exports`, { method: "POST" });
export async function downloadTerraformExport(projectId, artifact) { const response = await fetch(`${getApiBaseUrl()}/api/projects/${id(projectId)}/infrastructure/exports/${id(artifact.id)}/download`, { credentials: "include" }); if (!response.ok) { const payload = await response.json().catch(() => ({})); throw new Error(payload.message || "Export download failed"); } const blob = await response.blob(); const url = URL.createObjectURL(blob); const anchor = document.createElement("a"); anchor.href = url; anchor.download = artifact.filename; anchor.click(); URL.revokeObjectURL(url); }
