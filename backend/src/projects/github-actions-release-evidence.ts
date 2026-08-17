export type GithubActionsReleaseEvidence = {
  contractVersion: typeof DEPLOYGUARD_DEPLOYMENT_RESULT_CONTRACT_VERSION;
  deploymentOperationId: string | null;
  generationId: string;
  commitSha: string;
  environmentName: string;
  imageUri: string;
  imageDigest: string;
  components?: Array<{
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
  }>;
  taskDefinitionArn: string;
  clusterName: string;
  serviceName: string;
  ecsServiceArn: string;
  targetGroupArn: string;
  listenerRuleArn: string;
  routingVerified: true;
  candidateRouteRemoved: true;
  appPort: number;
  healthCheckPath: string;
  configurationFingerprint: string;
  configurationSnapshotId: string | null;
  databaseBindingId: string | null;
  secretReferenceNames: string[];
  databaseOutputs: Record<string, string> | null;
  promotionIntentFingerprint: string;
};

export const DEPLOYGUARD_DEPLOYMENT_RESULT_CONTRACT_VERSION = "deployguard.deployment-result/v2";
export const DEPLOYGUARD_DEPLOYMENT_RESULT_FIELDS = [
  "contractVersion", "deploymentOperationId", "generationId", "environmentName", "commitSha", "imageUri", "imageDigest",
  "taskDefinitionArn", "clusterName", "serviceName", "ecsServiceArn", "targetGroupArn", "listenerRuleArn", "routingVerified", "candidateRouteRemoved", "appPort", "healthCheckPath", "configurationFingerprint",
  "configurationSnapshotId", "databaseBindingId", "secretReferenceNames", "databaseOutputs",
] as const;

export type RuntimeEvidenceContractIssue = {
  field: string;
  reason: "missing" | "mismatched" | "invalid" | "unsupported_contract_version";
};

export class RuntimeEvidenceContractError extends Error {
  constructor(public readonly issues: RuntimeEvidenceContractIssue[]) {
    super("Immutable runtime evidence validation failed.");
  }
}

export type RuntimeEvidenceExpectation = {
  deploymentOperationId: string;
  generationId: string;
  commitSha: string;
  environmentName: string;
  configurationSnapshotId: string | null;
  configurationFingerprint: string;
  databaseBindingId: string | null;
  runtimeDatabaseBindingId: string | null;
  secretReferenceNames: string[];
  promotionIntentFingerprint: string;
};

export function validateGithubActionsRuntimeEvidence(
  evidence: GithubActionsReleaseEvidence | null,
  expected: RuntimeEvidenceExpectation,
) {
  const issues: RuntimeEvidenceContractIssue[] = [];
  if (!evidence) return [{ field: "deploymentResult", reason: "missing" as const }];
  const compare = (field: string, actual: unknown, wanted: unknown) => {
    if (actual !== wanted) issues.push({ field, reason: "mismatched" });
  };
  compare("deploymentOperationId", evidence.deploymentOperationId, expected.deploymentOperationId);
  compare("generationId", evidence.generationId, expected.generationId);
  compare("commitSha", evidence.commitSha, expected.commitSha);
  compare("environmentName", evidence.environmentName, expected.environmentName);
  compare("configurationSnapshotId", evidence.configurationSnapshotId, expected.configurationSnapshotId ?? null);
  compare("configurationFingerprint", evidence.configurationFingerprint, expected.configurationFingerprint);
  compare("databaseBindingId", evidence.databaseBindingId, expected.databaseBindingId ?? null);
  compare("promotionIntentFingerprint", evidence.promotionIntentFingerprint, expected.promotionIntentFingerprint);
  compare("runtime.managedDatabase.bindingId", expected.runtimeDatabaseBindingId ?? null, expected.databaseBindingId ?? null);
  if (JSON.stringify([...evidence.secretReferenceNames].sort()) !== JSON.stringify([...expected.secretReferenceNames].sort())) {
    issues.push({ field: "secretReferenceNames", reason: "mismatched" });
  }
  return issues;
}

export function sanitizedRuntimeEvidenceFailure(
  error: unknown,
  githubRunId: string | null,
  commitSha: string,
) {
  const issues = error instanceof RuntimeEvidenceContractError
    ? error.issues
    : [{ field: "runtimeEvidence", reason: "invalid" as const }];
  const fields = [...new Set(issues.map((issue) => `${issue.field} (${issue.reason.replaceAll("_", " ")})`))];
  return [
    "Runtime evidence validation failed",
    `Contract: ${DEPLOYGUARD_DEPLOYMENT_RESULT_CONTRACT_VERSION}`,
    "Missing/mismatched fields:",
    ...fields.map((field) => `- ${field}`),
    `GitHub run: ${githubRunId || "unavailable"}`,
    `Commit: ${commitSha.slice(0, 12)}`,
  ].join("\n");
}

const DIGEST = /^sha256:[0-9a-f]{64}$/;
const IMAGE_URI = /^\d{12}\.dkr\.ecr\.[a-z0-9-]+\.amazonaws\.com\/[a-z0-9][a-z0-9._/-]*@sha256:[0-9a-f]{64}$/;
const TASK_DEFINITION_ARN = /^arn:aws:ecs:[a-z0-9-]+:\d{12}:task-definition\/[A-Za-z0-9_-]+:\d+$/;
const ECS_SERVICE_ARN = /^arn:aws:ecs:[a-z0-9-]+:\d{12}:service\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+$/;
const TARGET_GROUP_ARN = /^arn:aws:elasticloadbalancing:[a-z0-9-]+:\d{12}:targetgroup\/[A-Za-z0-9_-]+\/[A-Za-z0-9]+$/;
const LISTENER_RULE_ARN = /^arn:aws:elasticloadbalancing:[a-z0-9-]+:\d{12}:listener-rule\/app\/.+$/;
const RESOURCE_NAME = /^[A-Za-z0-9_-]{1,255}$/;
const FINGERPRINT = /^[0-9a-f]{64}$/;
const COMMIT_SHA = /^[0-9a-f]{40}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ENVIRONMENT = /^[a-z0-9][a-z0-9-]{0,39}$/;

export function extractGithubActionsReleaseEvidence(log: string): GithubActionsReleaseEvidence | null {
  const lines = log.split(/\r?\n/).filter((line) => line.includes("DEPLOYGUARD_RELEASE_RESULT="));
  for (const line of lines.reverse()) {
    const marker = line.indexOf("DEPLOYGUARD_RELEASE_RESULT=");
    const serialized = line.slice(marker + "DEPLOYGUARD_RELEASE_RESULT=".length).trim();
    try {
      const value = JSON.parse(serialized) as Record<string, unknown>;
      if (value.contractVersion !== undefined && value.contractVersion !== DEPLOYGUARD_DEPLOYMENT_RESULT_CONTRACT_VERSION) {
        throw new RuntimeEvidenceContractError([{ field: "contractVersion", reason: "unsupported_contract_version" }]);
      }
      const appPort = value.appPort;
      const components = Array.isArray(value.components) ? value.components as Array<Record<string, unknown>> : [];
      const primaryComponent = components.find((component) => component.role === "frontend") || components[0];
      const componentsValid = components.length === 0 || (components.length <= 2
        && new Set(components.map((component) => component.id)).size === components.length
        && components.every((component) => /^[a-z][a-z0-9-]{0,31}$/.test(String(component.id || ""))
          && ["application", "frontend", "backend"].includes(String(component.role || ""))
          && /^(?:\.|[A-Za-z0-9._/-]+)$/.test(String(component.root || ""))
          && component.buildContext === component.root
          && typeof component.imageUri === "string" && IMAGE_URI.test(component.imageUri)
          && typeof component.imageDigest === "string" && DIGEST.test(component.imageDigest)
          && component.imageUri.endsWith(`@${component.imageDigest}`)
          && typeof component.taskDefinitionArn === "string" && TASK_DEFINITION_ARN.test(component.taskDefinitionArn)
          && typeof component.ecsServiceArn === "string" && ECS_SERVICE_ARN.test(component.ecsServiceArn)
          && Number.isInteger(component.port) && Number(component.port) >= 1 && Number(component.port) <= 65535
          && typeof component.healthPath === "string" && String(component.healthPath).startsWith("/")
          && component.verified === true)
        && primaryComponent?.imageUri === value.imageUri
        && primaryComponent?.imageDigest === value.imageDigest);
      if (
        !componentsValid
        || typeof value.imageUri !== "string" || !IMAGE_URI.test(value.imageUri)
        || typeof value.commitSha !== "string" || !COMMIT_SHA.test(value.commitSha)
        || typeof value.environmentName !== "string" || !ENVIRONMENT.test(value.environmentName)
        || typeof value.imageDigest !== "string" || !DIGEST.test(value.imageDigest)
        || !value.imageUri.endsWith(`@${value.imageDigest}`)
        || typeof value.taskDefinitionArn !== "string" || !TASK_DEFINITION_ARN.test(value.taskDefinitionArn)
        || typeof value.generationId !== "string" || !UUID.test(value.generationId)
        || typeof value.clusterName !== "string" || !RESOURCE_NAME.test(value.clusterName)
        || typeof value.serviceName !== "string" || !RESOURCE_NAME.test(value.serviceName)
        || typeof value.ecsServiceArn !== "string" || !ECS_SERVICE_ARN.test(value.ecsServiceArn)
        || typeof value.targetGroupArn !== "string" || !TARGET_GROUP_ARN.test(value.targetGroupArn)
        || typeof value.listenerRuleArn !== "string" || !LISTENER_RULE_ARN.test(value.listenerRuleArn)
        || value.routingVerified !== true
        || value.candidateRouteRemoved !== true
        || typeof appPort !== "number" || !Number.isInteger(appPort) || appPort < 1 || appPort > 65535
        || typeof value.healthCheckPath !== "string" || !/^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*$/.test(value.healthCheckPath)
        || typeof value.configurationFingerprint !== "string" || !FINGERPRINT.test(value.configurationFingerprint)
        || typeof value.promotionIntentFingerprint !== "string" || !FINGERPRINT.test(value.promotionIntentFingerprint)
      ) continue;
      return {
        contractVersion: DEPLOYGUARD_DEPLOYMENT_RESULT_CONTRACT_VERSION,
        deploymentOperationId: typeof value.deploymentOperationId === "string" && UUID.test(value.deploymentOperationId) ? value.deploymentOperationId : null,
        generationId: value.generationId,
        commitSha: value.commitSha,
        environmentName: value.environmentName,
        imageUri: value.imageUri,
        imageDigest: value.imageDigest,
        components: components.length ? components as GithubActionsReleaseEvidence["components"] : undefined,
        taskDefinitionArn: value.taskDefinitionArn,
        clusterName: value.clusterName,
        serviceName: value.serviceName,
        ecsServiceArn: value.ecsServiceArn,
        targetGroupArn: value.targetGroupArn,
        listenerRuleArn: value.listenerRuleArn,
        routingVerified: true,
        candidateRouteRemoved: true,
        appPort,
        healthCheckPath: value.healthCheckPath,
        configurationFingerprint: value.configurationFingerprint,
        configurationSnapshotId: typeof value.configurationSnapshotId === "string" && UUID.test(value.configurationSnapshotId) ? value.configurationSnapshotId : null,
        databaseBindingId: typeof value.databaseBindingId === "string" && UUID.test(value.databaseBindingId) ? value.databaseBindingId : null,
        secretReferenceNames: Array.isArray(value.secretReferenceNames)
          ? [...new Set(value.secretReferenceNames.filter((item): item is string => typeof item === "string" && /^[A-Z][A-Z0-9_]{0,127}$/.test(item)))].sort()
          : [],
        databaseOutputs: value.databaseOutputs && typeof value.databaseOutputs === "object" && !Array.isArray(value.databaseOutputs)
          ? Object.fromEntries(Object.entries(value.databaseOutputs as Record<string, unknown>).filter(([, item]) => typeof item === "string")) as Record<string, string>
          : null,
        promotionIntentFingerprint: value.promotionIntentFingerprint,
      };
    } catch (error) {
      if (error instanceof RuntimeEvidenceContractError) throw error;
      // Ignore malformed or unrelated log lines and fail closed with no evidence.
    }
  }
  return null;
}
