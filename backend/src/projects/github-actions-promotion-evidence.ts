import { createHash } from "node:crypto";
import { BuildPlan, buildPlanComponents } from "./build-plan";

export const DEPLOYGUARD_CANDIDATE_RESULT_CONTRACT_VERSION = "deployguard.candidate-result/v2";
export const DEPLOYGUARD_COMPENSATION_RESULT_CONTRACT_VERSION = "deployguard.promotion-compensation/v1";

export type GithubActionsCandidateEvidence = {
  contractVersion: typeof DEPLOYGUARD_CANDIDATE_RESULT_CONTRACT_VERSION;
  deploymentOperationId: string;
  projectId: string;
  generationId: string;
  environmentName: string;
  commitSha: string;
  candidateUrl: string;
  imageUri: string;
  imageDigest: string;
  components?: GithubActionsComponentEvidence[];
  clusterName: string;
  serviceName: string;
  ecsServiceArn: string;
  targetGroupArn: string;
  candidateListenerRuleArn: string;
  taskDefinitionArn: string;
  appPort: number;
  healthCheckPath: string;
  configurationFingerprint: string;
  configurationSnapshotId: string | null;
  databaseBindingId: string | null;
  secretReferenceNames: string[];
  databaseOutputs: Record<string, string> | null;
  health: {
    ecsStable: true;
    expectedTaskDefinitionRunning: true;
    expectedImageRunning: true;
    componentSetVerified?: true;
    frontendHttpVerified?: true;
    backendComponentHealthVerified?: true;
    /**
     * `verified` means the BuildPlan-proven relationship endpoint was called
     * successfully. `not_required` means no such endpoint was proven; it does
     * not claim that the routing prefix itself was called.
     */
    relationshipVerificationStatus: "verified" | "not_required";
    targetHealthVerified: true;
    candidateHttpVerified: true;
    healthyTargetCount: number;
    targetStates: "healthy"[];
  };
};

export type GithubActionsComponentEvidence = {
  id: string;
  role: "application" | "frontend" | "backend";
  root: string;
  buildContext: string;
  framework: string;
  frameworkMode: string;
  imageUri: string;
  imageDigest: string;
  taskDefinitionArn: string;
  serviceName: string;
  ecsServiceArn: string;
  port: number;
  healthPath: string;
  verified: true;
};

export type PromotionIntent = {
  contractVersion: "deployguard.promotion-intent/v1";
  operationId: string;
  projectId: string;
  environmentName: string;
  generationId: string;
  candidate: GithubActionsCandidateEvidence | null;
  previousLiveGenerationId: string | null;
  previousTargetGroupArn: string | null;
  previousListenerRuleArn: string | null;
  previousProductionUrl: string | null;
  intentFingerprint: string | null;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA = /^[0-9a-f]{40}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const IMAGE = /^\d{12}\.dkr\.ecr\.[a-z0-9-]+\.amazonaws\.com\/[a-z0-9][a-z0-9._/-]*@sha256:[0-9a-f]{64}$/;
const TARGET_GROUP = /^arn:aws:elasticloadbalancing:[a-z0-9-]+:\d{12}:targetgroup\/[A-Za-z0-9_-]+\/[A-Za-z0-9]+$/;
const LISTENER_RULE = /^arn:aws:elasticloadbalancing:[a-z0-9-]+:\d{12}:listener-rule\/app\/.+$/;
const TASK = /^arn:aws:ecs:[a-z0-9-]+:\d{12}:task-definition\/[A-Za-z0-9_-]+:\d+$/;
const SERVICE = /^arn:aws:ecs:[a-z0-9-]+:\d{12}:service\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+$/;

export function isGithubActionsCandidateEvidence(value: unknown): value is GithubActionsCandidateEvidence {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, any>;
  const health = candidate.health as Record<string, any> | undefined;
  const components = Array.isArray(candidate.components) ? candidate.components as Array<Record<string, unknown>> : [];
  const primaryComponent = components.find((component) => component.role === "frontend") || components[0];
  const componentsValid = components.length === 0 || (components.length <= 2
    && new Set(components.map((component) => component.id)).size === components.length
    && components.every((component) => /^[a-z][a-z0-9-]{0,31}$/.test(String(component.id || ""))
      && ["application", "frontend", "backend"].includes(String(component.role || ""))
      && /^(?:\.|[A-Za-z0-9._/-]+)$/.test(String(component.root || ""))
      && component.buildContext === component.root
      && IMAGE.test(String(component.imageUri || ""))
      && DIGEST.test(String(component.imageDigest || ""))
      && String(component.imageUri).endsWith(`@${component.imageDigest}`)
      && TASK.test(String(component.taskDefinitionArn || ""))
      && SERVICE.test(String(component.ecsServiceArn || ""))
      && Number.isInteger(component.port) && Number(component.port) >= 1 && Number(component.port) <= 65535
      && typeof component.healthPath === "string" && String(component.healthPath).startsWith("/")
      && component.verified === true)
    && primaryComponent?.imageUri === candidate.imageUri
    && primaryComponent?.imageDigest === candidate.imageDigest);
  return componentsValid
    && candidate.contractVersion === DEPLOYGUARD_CANDIDATE_RESULT_CONTRACT_VERSION
    && UUID.test(String(candidate.deploymentOperationId || ""))
    && UUID.test(String(candidate.projectId || ""))
    && UUID.test(String(candidate.generationId || ""))
    && /^[a-z0-9][a-z0-9-]{0,39}$/.test(String(candidate.environmentName || ""))
    && SHA.test(String(candidate.commitSha || ""))
    && IMAGE.test(String(candidate.imageUri || ""))
    && DIGEST.test(String(candidate.imageDigest || ""))
    && String(candidate.imageUri).endsWith(`@${candidate.imageDigest}`)
    && TARGET_GROUP.test(String(candidate.targetGroupArn || ""))
    && LISTENER_RULE.test(String(candidate.candidateListenerRuleArn || ""))
    && TASK.test(String(candidate.taskDefinitionArn || ""))
    && SERVICE.test(String(candidate.ecsServiceArn || ""))
    && typeof candidate.candidateUrl === "string" && /^https?:\/\//.test(candidate.candidateUrl)
    && Number.isInteger(candidate.appPort) && candidate.appPort >= 1 && candidate.appPort <= 65535
    && health?.ecsStable === true
    && health?.expectedTaskDefinitionRunning === true
    && health?.expectedImageRunning === true
    && health?.targetHealthVerified === true
    && health?.candidateHttpVerified === true
    && (health?.relationshipVerificationStatus === "verified" || health?.relationshipVerificationStatus === "not_required")
    && health?.relationshipVerified === undefined
    && (components.length < 2 || (health?.componentSetVerified === true
      && health?.frontendHttpVerified === true
      && health?.backendComponentHealthVerified === true))
    && Number.isInteger(health?.healthyTargetCount) && health.healthyTargetCount >= 1
    && Array.isArray(health?.targetStates) && health.targetStates.length >= 1
    && health.targetStates.every((state: unknown) => state === "healthy");
}

/**
 * Promotion has both the candidate evidence and its immutable BuildPlan, so
 * this is the point where a status is bound to the relationship it describes.
 */
export function relationshipVerificationMatchesBuildPlan(
  candidate: GithubActionsCandidateEvidence,
  plan: BuildPlan | null,
) {
  if (!plan) return false;
  const components = buildPlanComponents(plan);
  const fullStack = components.filter((component) => component.role === "frontend").length === 1
    && components.filter((component) => component.role === "backend").length === 1;
  const relationships = plan.relationships || [];
  if (!fullStack) return candidate.health.relationshipVerificationStatus === "not_required";
  // Route evidence is optional under the service-binding contract.  A
  // full-stack candidate without a concrete request is truthfully
  // `not_required`, rather than being rejected for missing reconstruction.
  if (relationships.length === 0) return candidate.health.relationshipVerificationStatus === "not_required";
  if (relationships.length !== 1) return false;
  return candidate.health.relationshipVerificationStatus
    === (relationships[0].verificationPath ? "verified" : "not_required");
}

export function extractGithubActionsCandidateEvidence(log: string): GithubActionsCandidateEvidence | null {
  const lines = log.split(/\r?\n/).filter((line) => line.includes("DEPLOYGUARD_CANDIDATE_RESULT="));
  for (const line of lines.reverse()) {
    const raw = line.slice(line.indexOf("DEPLOYGUARD_CANDIDATE_RESULT=") + "DEPLOYGUARD_CANDIDATE_RESULT=".length).trim();
    try {
      const value = JSON.parse(raw) as Record<string, any>;
      if (!isGithubActionsCandidateEvidence(value)) continue;
      return value as GithubActionsCandidateEvidence;
    } catch {
      // Malformed marker is not authoritative evidence.
    }
  }
  return null;
}

export function promotionIntentFingerprint(intent: Omit<PromotionIntent, "intentFingerprint">) {
  return createHash("sha256").update(JSON.stringify(intent)).digest("hex");
}

export function extractGithubActionsCompensationEvidence(log: string) {
  const lines = log.split(/\r?\n/).filter((line) => line.includes("DEPLOYGUARD_COMPENSATION_RESULT="));
  for (const line of lines.reverse()) {
    try {
      const raw = line.slice(line.indexOf("DEPLOYGUARD_COMPENSATION_RESULT=") + "DEPLOYGUARD_COMPENSATION_RESULT=".length).trim();
      const value = JSON.parse(raw) as Record<string, unknown>;
      if (value.contractVersion === DEPLOYGUARD_COMPENSATION_RESULT_CONTRACT_VERSION
        && typeof value.deploymentOperationId === "string" && UUID.test(value.deploymentOperationId)
        && typeof value.generationId === "string" && UUID.test(value.generationId)
        && typeof value.intentFingerprint === "string" && /^[0-9a-f]{64}$/.test(value.intentFingerprint)
        && value.status === "compensated") return value;
    } catch { /* fail closed */ }
  }
  return null;
}
