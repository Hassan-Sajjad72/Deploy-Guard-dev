import { apiRequest } from "./client.js";

export function getUsers() {
  return apiRequest("/api/admin/users");
}

export function getAdminOverview() {
  return apiRequest("/api/admin/overview");
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
