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
