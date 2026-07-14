import { apiRequest } from "./client.js";

export function getUsers() {
  return apiRequest("/api/admin/users");
}

export function updateUserRole(userId, role) {
  return apiRequest(`/api/admin/users/${encodeURIComponent(userId)}/role`, {
    method: "PATCH",
    body: { role },
  });
}
