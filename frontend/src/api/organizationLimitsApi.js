import { apiRequest } from "./client.js";
export const getOrganizationEntitlements = (id) => apiRequest(`/api/workspaces/${encodeURIComponent(id)}/entitlements`);
export const getAdminOrganizationEntitlements = (id) => apiRequest(`/api/admin/organizations/${encodeURIComponent(id)}/entitlements`);
export const publishOrganizationEntitlements = (id, body) => apiRequest(`/api/admin/organizations/${encodeURIComponent(id)}/entitlements`, { method: "POST", body });
