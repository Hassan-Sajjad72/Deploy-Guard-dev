import { DeveloperProjectCurrentState } from "../projects/current-state/project-current-state.types";
import { knownMonthlyPrice } from "../finops/pricing-amount";

export type EvidenceSupplement = {
  configurationRequirements: Array<{ serviceId: string; key: string; scope: string; required: boolean; secret: boolean }>;
  releases: Array<{ id: string; sourceSha: string; operationId: string; generationId: string | null; status: string; deployedAt: Date }>;
  approvals: Array<{ planId: string; actorUserId: number; actorRole: string; decision: string; fingerprint: string; environment: string; operationId: string; monthlyBudgetUsd: string; createdAt: Date }>;
  scans: Array<{ operationId: string; sourceSha: string; status: string; evidenceHash: string | null; recordedAt: Date }>;
  rollbackHistory: Array<{ operationId: string; sourceSha: string; generationId: string | null; status: string; completedAt: Date | null }>;
};

function runtimeInventory(identity: Record<string, unknown> | null | undefined) {
  const allowed = ["serviceId", "serviceName", "ecsServiceArn", "taskDefinitionArn", "targetGroupArn", "imageUri", "imageDigest", "runtimeConfigRevisionId", "publicUrl", "cloudWatchLogGroup"];
  const services = Array.isArray(identity?.services) ? identity.services : [];
  return services.slice(0, 20).map((item) => Object.fromEntries(allowed.filter((key) => typeof item?.[key] === "string").map((key) => [key, item[key]])));
}

export function operationalEvidence(project: { id: string; name: string; organizationId: string; clientId?: string | null; engagementId?: string | null; environmentName?: string; executionMode?: string; awsAccountBindingId?: string | null }, state: DeveloperProjectCurrentState, supplement?: EvidenceSupplement) {
  const infrastructure = state.infrastructureEvidence;
  const identity = infrastructure?.runtimeIdentity || state.stableRelease?.runtimeIdentity;
  return {
    contractVersion: "deployguard.operational-evidence/v1",
    exportedAt: new Date().toISOString(),
    project: { id: project.id, name: project.name, organizationId: project.organizationId, clientId: project.clientId || null, engagementId: project.engagementId || null },
    scope: { environment: project.environmentName || "dev", awsAccountBindingId: project.awsAccountBindingId || null,
      executionMode: project.executionMode || "unverified", region: infrastructure?.region || null,
      accountId: typeof identity?.accountId === "string" && /^\d{12}$/.test(identity.accountId) ? identity.accountId : null },
    topology: { hostingProfile: infrastructure?.ecs ? "ecs_fargate" : null, resourceInventory: runtimeInventory(identity),
      cluster: infrastructure?.ecs?.cluster || null, observations: (infrastructure?.services || []).map((service) => ({
        serviceId: service.serviceId, serviceName: service.serviceName, publicUrl: service.publicUrl, imageDigest: service.imageDigest,
        ecs: { service: service.ecs.service, desiredCount: service.ecs.desiredCount, runningCount: service.ecs.runningCount, pendingCount: service.ecs.pendingCount },
        targetHealth: service.alb.targetHealth,
      })), persistentStorage: infrastructure?.persistentStorage ? { type: infrastructure.persistentStorage.type, status: infrastructure.persistentStorage.status,
        encrypted: infrastructure.persistentStorage.encrypted, backupEnabled: infrastructure.persistentStorage.backupEnabled, region: infrastructure.persistentStorage.region } : null },
    provenance: { source: infrastructure?.source || "unavailable", observedAt: infrastructure?.lastUpdatedAt || null,
      freshness: infrastructure?.freshness || "unavailable", realProviderCertification: "unverified" },
    release: state.stableRelease ? {
      id: state.stableRelease.id || null, operationId: state.stableRelease.operationId || null,
      generationId: state.stableRelease.generationId, commitSha: state.stableRelease.commit,
      promotedAt: state.stableRelease.promotedAt, rollbackAvailable: state.stableRelease.rollbackAvailable,
    } : null,
    runtime: state.stateAuthority?.runtime || null,
    infrastructure: state.stateAuthority?.infrastructure || null,
    applicationHealth: state.stateAuthority?.applicationHealth || null,
    monitoring: state.stateAuthority?.monitoring || null,
    reconciliation: state.stateAuthority?.reconciliation || null,
    cost: state.estimatedCost ? {
      status: state.estimatedCost.status, source: state.estimatedCost.source, currency: state.estimatedCost.currency,
      monthly: state.estimatedCost.monthly != null && Number.isFinite(state.estimatedCost.monthly) && state.estimatedCost.monthly >= 0 ? state.estimatedCost.monthly : null, estimatedAt: state.estimatedCost.estimatedAt,
      releaseId: state.estimatedCost.releaseId, operationId: state.estimatedCost.operationId,
      items: (state.estimatedCost.breakdown || []).map((item) => ({ name: item.name, service: item.service, monthly: knownMonthlyPrice(item.monthly) })),
    } : null,
    configurationRequirements: supplement?.configurationRequirements || [],
    releaseHistory: supplement?.releases || [], approvals: supplement?.approvals || [],
    securityScans: supplement?.scans || [], rollbackHistory: supplement?.rollbackHistory || [],
    historyLimit: 50,
    limitations: ["Local source and tests do not certify real AWS deployment or cross-account isolation.", "Release estimates describe the recorded release; future usage and unknown prices are not guaranteed."],
  };
}

export function evidencePdfLines(evidence: ReturnType<typeof operationalEvidence>) {
  const cost = evidence.cost;
  return [
    "DeployGuard Operational Evidence",
    `Project: ${evidence.project.name.slice(0, 70)}`,
    `Project ID: ${evidence.project.id}`,
    `Workspace: ${evidence.project.organizationId || "Legacy user ownership"}`,
    `Environment: ${evidence.scope.environment}`,
    `AWS account: ${evidence.scope.accountId || "Unverified"}`,
    `AWS region: ${evidence.scope.region || "Unverified"}`,
    `Exported: ${evidence.exportedAt}`,
    `Release: ${evidence.release?.id || "Unavailable"}`,
    `Generation: ${evidence.release?.generationId || "Unavailable"}`,
    `Commit: ${evidence.release?.commitSha || "Unavailable"}`,
    `Runtime: ${evidence.runtime?.state || "Unavailable"}`,
    `Infrastructure: ${evidence.infrastructure?.status || "Unavailable"}`,
    `Application health: ${evidence.applicationHealth?.status || "Unavailable"}`,
    `Health observed: ${evidence.applicationHealth?.observedAt || "Unavailable"}`,
    `Monitoring: ${evidence.monitoring?.status || "Unavailable"}`,
    `Cost source: ${cost?.source || "Unavailable"}`,
    `Estimated monthly cost: ${cost?.monthly == null ? "Unknown" : `${cost.monthly.toFixed(2)} ${cost.currency || "USD"}`}`,
    `Cost estimated: ${cost?.estimatedAt || "Unavailable"}`,
    "Real AWS and cross-account certification require separate authorized verification.",
    "Recorded release estimates do not guarantee future usage or unknown prices.",
    "Use the JSON export for the structured evidence and cost breakdown.",
    "Resource inventory",
    ...evidence.topology.resourceInventory.flatMap((item) => Object.entries(item).map(([key, value]) => `${key}: ${value}`)),
    "Configuration requirements (values excluded)",
    ...evidence.configurationRequirements.map((item) => `${item.serviceId}: ${item.key}, ${item.scope}, ${item.required ? "required" : "optional"}, ${item.secret ? "secret reference" : "non-secret"}`),
    "Release history",
    ...evidence.releaseHistory.flatMap((item) => [`${item.id}: ${item.status}`, `Source: ${item.sourceSha}`, `Operation: ${item.operationId}`, `Deployed: ${item.deployedAt.toISOString()}`]),
    "Plan decisions",
    ...evidence.approvals.flatMap((item) => [`${item.planId}: ${item.decision}`, `Actor: ${item.actorUserId} (${item.actorRole})`, `Fingerprint: ${item.fingerprint}`, `Budget: ${item.monthlyBudgetUsd} USD/month`, `Decided: ${item.createdAt.toISOString()}`]),
    "Security scan evidence",
    ...evidence.securityScans.map((item) => `${item.operationId}: ${item.status}, source ${item.sourceSha}`),
    "Rollback history",
    ...evidence.rollbackHistory.map((item) => `${item.operationId}: ${item.status}, source ${item.sourceSha}`),
  ];
}
