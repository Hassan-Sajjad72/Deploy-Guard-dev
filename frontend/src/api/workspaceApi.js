import { apiRequest } from "./client.js";

export function getWorkspaces() { return apiRequest("/api/workspaces"); }
export function createWorkspace(body) { return apiRequest("/api/workspaces", { method: "POST", body }); }
export function renameWorkspace(id, name) { return apiRequest(`/api/workspaces/${encodeURIComponent(id)}`, { method: "PUT", body: { name } }); }
export function archiveWorkspace(id, reason) { return apiRequest(`/api/workspaces/${encodeURIComponent(id)}/archive`, { method: "POST", body: { reason } }); }
export function getWorkspaceMembers(id) { return apiRequest(`/api/workspaces/${encodeURIComponent(id)}/members`); }
export function setWorkspaceMember(id, body) { return apiRequest(`/api/workspaces/${encodeURIComponent(id)}/members`, { method: "PUT", body }); }
export function removeWorkspaceMember(id, userId) { return apiRequest(`/api/workspaces/${encodeURIComponent(id)}/members/${encodeURIComponent(userId)}`, { method: "DELETE" }); }
export function getAwsBindings(id) { return apiRequest(`/api/workspaces/${encodeURIComponent(id)}/aws-bindings`); }
export function createAwsBinding(id, body) { return apiRequest(`/api/workspaces/${encodeURIComponent(id)}/aws-bindings`, { method: "POST", body }); }
export function getBindingTrustPolicy(id, bindingId) { return apiRequest(`/api/workspaces/${encodeURIComponent(id)}/aws-bindings/${encodeURIComponent(bindingId)}/trust-policy`); }
export function verifyAwsBinding(id, bindingId) { return apiRequest(`/api/workspaces/${encodeURIComponent(id)}/aws-bindings/${encodeURIComponent(bindingId)}/verify`, { method: "POST" }); }
export function revokeAwsBinding(id, bindingId) { return apiRequest(`/api/workspaces/${encodeURIComponent(id)}/aws-bindings/${encodeURIComponent(bindingId)}`, { method: "DELETE" }); }
export function getAgencyPortfolio(id) { return apiRequest(`/api/workspaces/${encodeURIComponent(id)}/portfolio`); }
export function createAgencyClient(id, body) { return apiRequest(`/api/workspaces/${encodeURIComponent(id)}/clients`, { method: "POST", body }); }
export function createAgencyEngagement(id, clientId, body) { return apiRequest(`/api/workspaces/${encodeURIComponent(id)}/clients/${encodeURIComponent(clientId)}/engagements`, { method: "POST", body }); }
export function renameAgencyRecord(id, kind, recordId, name) { return apiRequest(`/api/workspaces/${encodeURIComponent(id)}/${kind}/${encodeURIComponent(recordId)}`, { method: "PUT", body: { name } }); }
export function archiveAgencyRecord(id, kind, recordId, reason) { return apiRequest(`/api/workspaces/${encodeURIComponent(id)}/${kind}/${encodeURIComponent(recordId)}/archive`, { method: "POST", body: { reason } }); }
