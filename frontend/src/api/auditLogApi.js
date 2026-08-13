import { apiRequest } from "./client.js";

export function getAuditLogs(filters = {}) {
  const params = new URLSearchParams();

  Object.entries(filters).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") {
      params.set(key, String(value));
    }
  });

  const query = params.toString();

  return apiRequest(`/api/audit-logs${query ? `?${query}` : ""}`);
}
