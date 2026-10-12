import { apiRequest } from "./client.js";

export function getUsers() {
  return apiRequest("/api/admin/users");
}

export function getAdminOverview() {
  return apiRequest("/api/admin/overview");
}

export function getAdminProjects() {
  return apiRequest("/api/admin/projects");
}
export const getAdminOrganizations = () => apiRequest("/api/admin/organizations");

export function getAdminAuditLogs(filters = {}) {
  const params = new URLSearchParams();
  Object.entries(filters).forEach(([key, value]) => {
    if (value !== "" && value !== null && value !== undefined) params.set(key, String(value));
  });
  const query = params.toString();
  return apiRequest(`/api/admin/audit-logs${query ? `?${query}` : ""}`);
}

export function updateUserRole(userId, role, reason) {
  return apiRequest(`/api/admin/users/${encodeURIComponent(userId)}/role`, {
    method: "PATCH",
    body: { role, reason },
  });
}

export const verifyAdminIdentity = (password) => apiRequest("/api/admin/verify-identity", { method: "POST", body: { password } });
export const updateAdminAccount = (userId, body) => apiRequest(`/api/admin/users/${encodeURIComponent(userId)}/controls`, { method: "PATCH", body });
export const getAdminSupportAccess = () => apiRequest("/api/admin/support-access");
export const getAdminSupportEvidence = (grantId, projectId) => apiRequest(`/api/admin/support-access/${encodeURIComponent(grantId)}/projects/${encodeURIComponent(projectId)}`);
