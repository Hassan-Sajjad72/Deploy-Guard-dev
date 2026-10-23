import { apiRequest } from "./client.js";

const base = (id) => `/api/projects/${encodeURIComponent(id)}`;
export function listDeploymentPlans(id) { return apiRequest(`${base(id)}/deployment-plans`); }
export function getDeploymentPlan(id, planId) { return apiRequest(`${base(id)}/deployment-plans/${encodeURIComponent(planId)}`); }
export function createDeploymentPlan(id, body) { return apiRequest(`${base(id)}/deployment-plans`, { method: "POST", body }); }
export function decideDeploymentPlan(id, planId, body) { return apiRequest(`${base(id)}/deployment-plans/${encodeURIComponent(planId)}/decisions`, { method: "POST", body }); }
export function interpretDeploymentGoal(id, prompt) { return apiRequest(`${base(id)}/deployment-goals/interpret`, { method: "POST", body: { prompt } }); }

export function executeDeploymentPlan(id, planId, fingerprint) { return apiRequest(`${base(id)}/deployment-plans/${encodeURIComponent(planId)}/execute`, { method: "POST", body: { fingerprint } }); }
