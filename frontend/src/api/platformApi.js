import { apiRequest, getApiBaseUrl } from "./client.js";
const id = encodeURIComponent;
export const getTroubleshootingSessions = (projectId) => apiRequest(`/api/projects/${id(projectId)}/troubleshooting`);
export const getTroubleshootingSession = (projectId, sessionId) => apiRequest(`/api/projects/${id(projectId)}/troubleshooting/${id(sessionId)}`);
export const startTroubleshooting = (projectId, pipelineRunId, serviceId) => apiRequest(`/api/projects/${id(projectId)}/troubleshooting`, { method: "POST", body: { pipelineRunId, ...(serviceId ? { serviceId } : {}) } });
export const followUpTroubleshooting = (projectId, sessionId, message, questionType) => apiRequest(`/api/projects/${id(projectId)}/troubleshooting/${id(sessionId)}/follow-up`, { method: "POST", body: { message, ...(questionType ? { questionType } : {}) } });
export const regenerateTroubleshooting = (projectId, sessionId) => apiRequest(`/api/projects/${id(projectId)}/troubleshooting/${id(sessionId)}/regenerate`, { method: "POST" });
export const getNotificationSettings = (projectId) => apiRequest(`/api/projects/${id(projectId)}/notifications`);
export const updateNotificationSettings = (projectId, value) => apiRequest(`/api/projects/${id(projectId)}/notifications/preferences`, { method: "PATCH", body: value });
export const subscribeNotifications = (projectId, email) => apiRequest(`/api/projects/${id(projectId)}/notifications/subscribe`, { method: "POST", body: { email } });
export const refreshNotificationStatus = (projectId) => apiRequest(`/api/projects/${id(projectId)}/notifications/refresh-status`, { method: "POST" });
export const resendNotificationConfirmation = (projectId) => apiRequest(`/api/projects/${id(projectId)}/notifications/resend-confirmation`, { method: "POST" });
export const unsubscribeNotifications = (projectId) => apiRequest(`/api/projects/${id(projectId)}/notifications/unsubscribe`, { method: "POST" });
export const testNotification = (projectId) => apiRequest(`/api/projects/${id(projectId)}/notifications/test`, { method: "POST" });
export const createTerraformExport = (projectId) => apiRequest(`/api/projects/${id(projectId)}/infrastructure/exports`, { method: "POST" });
export async function downloadTerraformExport(projectId, artifact) { const response = await fetch(`${getApiBaseUrl()}/api/projects/${id(projectId)}/infrastructure/exports/${id(artifact.id)}/download`, { credentials: "include" }); if (!response.ok) { const payload = await response.json().catch(() => ({})); throw new Error(payload.message || "Export download failed"); } const blob = await response.blob(); const url = URL.createObjectURL(blob); const anchor = document.createElement("a"); anchor.href = url; anchor.download = artifact.filename; anchor.click(); URL.revokeObjectURL(url); }
