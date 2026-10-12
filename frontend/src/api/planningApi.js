import { apiRequest } from "./client.js";

const base = (id) => `/api/projects/${encodeURIComponent(id)}`;
export function listDeploymentPlans(id) { return apiRequest(`${base(id)}/deployment-plans`); }
export function getDeploymentPlan(id, planId) { return apiRequest(`${base(id)}/deployment-plans/${encodeURIComponent(planId)}`); }
export function createDeploymentPlan(id, body) { return apiRequest(`${base(id)}/deployment-plans`, { method: "POST", body }); }
export function decideDeploymentPlan(id, planId, body) { return apiRequest(`${base(id)}/deployment-plans/${encodeURIComponent(planId)}/decisions`, { method: "POST", body }); }
export function interpretDeploymentGoal(id, prompt) { return apiRequest(`${base(id)}/deployment-goals/interpret`, { method: "POST", body: { prompt } }); }

export function executeDeploymentPlan(id, planId, fingerprint) { return apiRequest(`${base(id)}/deployment-plans/${encodeURIComponent(planId)}/execute`, { method: "POST", body: { fingerprint } }); }

export function createCustomerLifecyclePlan(id, body) { return apiRequest(`${base(id)}/deployment-plans/lifecycle`, { method: "POST", body }); }

export function getProviderArtifacts(id, planId) { return apiRequest(`${base(id)}/deployment-plans/${encodeURIComponent(planId)}/provider-artifacts`); }
export function listProviderGenerations(id) { return apiRequest(`${base(id)}/provider-generations`); }
export function actOnProviderGeneration(id, generationId, action, body) { return apiRequest(`${base(id)}/provider-generations/${encodeURIComponent(generationId)}/${encodeURIComponent(action)}`, { method: "POST", body }); }
export function getProviderRuntime(id) { return apiRequest(`${base(id)}/provider-runtime`); }
export function startHostingBuild(id, body) { return apiRequest(`${base(id)}/hosting-builds`, { method: "POST", body }); }
export function getHostingBuild(id, buildId) { return apiRequest(`${base(id)}/hosting-builds/${encodeURIComponent(buildId)}`); }
