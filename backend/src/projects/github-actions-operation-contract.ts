import { createHash } from "crypto";
import { BuildPlan, buildPlanComponents } from "./build-plan";
import {
  DeploymentRecoveryDecision,
  isDispatchableDeploymentRecoveryDecision,
} from "./deployment-recovery-decision";
import {
  GithubActionsCandidateEvidence,
  isGithubActionsCandidateEvidence,
  PromotionIntent,
  promotionIntentFingerprint,
} from "./github-actions-promotion-evidence";
import { ManagedDatabaseEngine, managedDatabaseProfile } from "./managed-database-engine";

export const GITHUB_ACTIONS_WORKFLOW_CONTRACT_VERSION = "deployguard.workflow-call/v2";
export const GITHUB_ACTIONS_WORKFLOW_INPUTS = [
  { name: "deployment_action", required: true, type: "string", sensitive: false, since: 1 },
  { name: "deployment_operation_id", required: true, type: "string", sensitive: false, since: 1 },
  { name: "project_id", required: true, type: "string", sensitive: false, since: 1 },
  { name: "environment_name", required: true, type: "string", sensitive: false, since: 2 },
  { name: "repository_full_name", required: true, type: "string", sensitive: false, since: 2 },
  { name: "repository_branch", required: true, type: "string", sensitive: false, since: 2 },
  { name: "detection_profile_version", required: true, type: "string", sensitive: false, since: 2 },
  { name: "deployment_contract_version", required: true, type: "string", sensitive: false, since: 2 },
  { name: "build_plan_base64", required: true, type: "string", sensitive: false, since: 2 },
  { name: "image_tag", required: true, type: "string", sensitive: false, since: 2 },
  { name: "environment_references_base64", required: true, type: "string", sensitive: true, since: 2 },
  { name: "infrastructure_namespace", required: true, type: "string", sensitive: false, since: 2 },
  { name: "aws_region", required: true, type: "string", sensitive: false, since: 1 },
  { name: "aws_role_arn", required: true, type: "string", sensitive: false, since: 1 },
  { name: "vpc_id", required: true, type: "string", sensitive: false, since: 1 },
  { name: "public_subnet_ids", required: true, type: "string", sensitive: false, since: 1 },
  { name: "commit_sha", required: true, type: "string", sensitive: false, since: 1 },
  { name: "application_root", required: true, type: "string", sensitive: false, since: 1 },
  { name: "app_port", required: true, type: "number", sensitive: false, since: 1 },
  { name: "health_check_path", required: true, type: "string", sensitive: false, since: 1 },
  { name: "terraform_state_bucket", required: true, type: "string", sensitive: false, since: 1 },
  { name: "container_profile", required: true, type: "string", sensitive: false, since: 1 },
  { name: "output_directory", required: true, type: "string", sensitive: false, since: 1 },
  { name: "generated_dockerfile_base64", required: false, type: "string", sensitive: false, since: 1 },
  { name: "build_time_public_config_base64", required: false, type: "string", sensitive: true, since: 1 },
  { name: "rollback_source_operation_id", required: false, type: "string", sensitive: false, since: 2 },
  { name: "rollback_image_uri", required: false, type: "string", sensitive: false, since: 2 },
  { name: "rollback_task_definition_arn", required: false, type: "string", sensitive: false, since: 2 },
] as const;

export const GITHUB_ACTIONS_INPUT_NAMES = GITHUB_ACTIONS_WORKFLOW_INPUTS.map((input) => input.name);

export type GithubActionsOperationInputName = typeof GITHUB_ACTIONS_WORKFLOW_INPUTS[number]["name"];
export type GithubActionsOperationInputs = Record<GithubActionsOperationInputName, string>;
export const BUILD_PLAN_WORKFLOW_INPUT_NAMES = [
  "build_plan_base64", "application_root", "app_port", "health_check_path", "container_profile", "output_directory",
] as const;
export type BuildPlanWorkflowInputs = Pick<GithubActionsOperationInputs,
  "build_plan_base64" | "application_root" | "app_port" | "health_check_path" | "container_profile" | "output_directory"
>;

export function buildPlanWorkflowInputs(plan: BuildPlan): BuildPlanWorkflowInputs {
  if (plan.environmentOwnership.some((item) => item.secret && item.repositoryValue !== undefined)) {
    throw new GithubActionsOperationContractError("invalid_contract", "BuildPlan must not contain secret environment values.");
  }
  if (!/^(?:\.|[A-Za-z0-9._/-]+)$/.test(plan.appRoot) || plan.appRoot.startsWith("/") || plan.appRoot.split("/").includes("..")) {
    throw new GithubActionsOperationContractError("invalid_contract", "BuildPlan application root is unsafe.");
  }
  const components = buildPlanComponents(plan);
  if (components.length > 2
    || components.some((component) => !/^(?:\.|[A-Za-z0-9._/-]+)$/.test(component.buildContext) || component.buildContext.startsWith("/") || component.buildContext.split("/").includes(".."))
    || new Set(components.map((component) => component.id)).size !== components.length) {
    throw new GithubActionsOperationContractError("invalid_contract", "BuildPlan component inventory is unsafe or outside the bounded topology.");
  }
  const relationships = plan.relationships || [];
  const fullStack = components.filter((component) => component.role === "frontend").length === 1
    && components.filter((component) => component.role === "backend").length === 1;
  const safePath = (value: unknown) => typeof value === "string" && /^\/[A-Za-z0-9._~!$&()*+,;=:@%/-]+$/.test(value);
  if ((fullStack && relationships.length !== 1)
    || (!fullStack && relationships.length !== 0)
    || relationships.some((relationship) => relationship.from !== "frontend"
      || relationship.to !== "backend"
      || relationship.kind !== "http"
      || !["same-origin", "build-time-url"].includes(relationship.mode)
      || !safePath(relationship.pathPrefix)
      || !safePath(relationship.verificationPath))) {
    throw new GithubActionsOperationContractError("invalid_contract", "BuildPlan component routing evidence is incomplete or unsafe.");
  }
  const primary = components.find((component) => component.role === "frontend") || components[0];
  const outputDirectory = primary.runtimeType === "static" ? primary.outputDirectory || "" : "";
  if (outputDirectory && (!/^[A-Za-z0-9._/-]+$/.test(outputDirectory) || outputDirectory.startsWith("/") || outputDirectory.split("/").includes(".."))) {
    throw new GithubActionsOperationContractError("invalid_contract", "BuildPlan output directory is unsafe.");
  }
  return {
    build_plan_base64: Buffer.from(JSON.stringify(plan), "utf8").toString("base64"),
    application_root: primary.root,
    app_port: String(primary.port),
    health_check_path: primary.healthPath,
    container_profile: primary.dockerTemplate,
    output_directory: outputDirectory,
  };
}
const ROLLBACK_INPUT_NAMES = ["rollback_source_operation_id", "rollback_image_uri", "rollback_task_definition_arn"] as const;
const PRE_ROLLBACK_INPUT_NAMES = GITHUB_ACTIONS_INPUT_NAMES.filter((name) => !ROLLBACK_INPUT_NAMES.includes(name as typeof ROLLBACK_INPUT_NAMES[number]));
const DIRECT_CALLER_INPUT_NAMES = PRE_ROLLBACK_INPUT_NAMES.filter((name) =>
  !BUILD_PLAN_WORKFLOW_INPUT_NAMES.includes(name as typeof BUILD_PLAN_WORKFLOW_INPUT_NAMES[number])
);
export const GITHUB_ACTIONS_CALLER_INPUT_NAMES = [
  ...DIRECT_CALLER_INPUT_NAMES,
  "build_plan_contract_json",
  "rollback_release_json",
] as const;
export const GITHUB_ACTIONS_OPTIONAL_CALLER_INPUT_NAMES = [
  "generated_dockerfile_base64", "build_time_public_config_base64", "rollback_release_json",
] as const;
export type GithubActionsOperationErrorCode =
  | "wrong_repository"
  | "wrong_branch"
  | "stale_commit"
  | "invalid_contract"
  | "cross_project_contract"
  | "immutable_snapshot_missing"
  | "immutable_snapshot_tampered";

export class GithubActionsOperationContractError extends Error {
  constructor(public readonly code: GithubActionsOperationErrorCode, message: string) {
    super(message);
  }
}

type Identity = {
  id: string;
  repositoryFullName: string;
  targetBranch: string;
};

type ProfileIdentity = {
  id: string;
  projectId: string;
  repositoryFullName: string;
  targetBranch: string;
  commitSha: string;
  inputFingerprint: string;
};

export type ContractIdentity = {
  projectId: string;
  commitSha: string | null;
  detectionSourceCommit: string | null;
  contractHash: string;
  port: number;
  healthPath: string;
  appRoot: string;
  dockerTemplate: string | null;
  dockerStrategy: string;
  generatedDockerfile: string | null;
  runtimeType: string;
  outputDirectory: string | null;
  ecsPlan: {
    environmentMappings: Array<{ name: string }>;
    secretMappings: Array<{ name: string }>;
  };
};

export type GithubActionsRuntimeConfiguration = {
  schemaVersion: 1;
  configurationSnapshotId: string;
  configurationFingerprint: string;
  projectId: string;
  environmentName: string;
  generationId: string;
  generationStateKey: string;
  platformFoundation: {
    vpcId: string;
    publicSubnetIds: string[];
    ecsClusterArn: string;
    ecsClusterName: string;
    albArn: string;
    albDnsName: string;
    listenerArn: string;
    albSecurityGroupId: string;
  };
  routing: {
    listenerPriority: number;
    verificationPriority: number;
    productionHost: string;
    candidateHost: string;
  };
  projectPersistence: {
    stateKey: string;
    ecrRepositoryName: string;
    runtimeSecretName: string;
    ownershipScope: "project";
  };
  retiredGenerationCleanup: null | {
    generationId: string;
    terraformStateKey: string;
    resourceManifest: Record<string, unknown>;
  };
  environment: Record<string, string>;
  secretReferences: Record<string, string>;
  deploymentContext: DeploymentRecoveryDecision;
  retentionProtectedRelease: {
    imageDigests: string[];
    taskDefinitionArns: string[];
  };
  promotion: PromotionIntent;
  managedDatabase: null | {
    bindingId: string;
    bindingFingerprint: string;
    provider: "managed";
    engine: ManagedDatabaseEngine;
    image?: string;
    dataPath?: string;
    healthCheck?: string[];
    initializationEnvironment?: Array<{ name: string; valueSource: "databaseName" | "databaseUser" }>;
    initializationSecretNames?: string[];
    urlScheme?: "postgresql" | "mysql" | "mongodb";
    urlQuery?: string;
    host: string;
    port: number;
    databaseName: string;
    databaseUser: string;
    runtimeAliases: Record<string, string>;
    secretAliases: Record<string, "password" | "url">;
    persistenceEnabled: true;
  };
};

const CONFIGURATION_KEY = /^[A-Z][A-Z0-9_]{0,127}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FINGERPRINT = /^[0-9a-f]{64}$/;
const SECRET_VALUE_FROM = /^arn:(?:aws|aws-us-gov|aws-cn):secretsmanager:[a-z0-9-]+:\d{12}:secret:[A-Za-z0-9/_+=.@-]+(?::[A-Z][A-Z0-9_]{0,127}::)?$/;

export function assertInitialGithubActionsIdentity(
  project: Identity,
  profile: ProfileIdentity,
  contract: ContractIdentity,
  remoteCommit: string,
) {
  if (profile.projectId !== project.id || contract.projectId !== project.id) {
    throw new GithubActionsOperationContractError("cross_project_contract", "The deployment contract does not belong to this project.");
  }
  if (profile.repositoryFullName !== project.repositoryFullName) {
    throw new GithubActionsOperationContractError("wrong_repository", "Detection evidence belongs to a different repository.");
  }
  if (profile.targetBranch !== project.targetBranch) {
    throw new GithubActionsOperationContractError("wrong_branch", "Detection evidence belongs to a different branch.");
  }
  if (!profile.commitSha || profile.commitSha !== contract.commitSha || contract.detectionSourceCommit !== contract.commitSha || remoteCommit !== contract.commitSha) {
    throw new GithubActionsOperationContractError("stale_commit", "The configured branch changed after stack detection.");
  }
  if (!profile.inputFingerprint || !contract.contractHash || !Number.isInteger(contract.port) || contract.port < 1 || contract.port > 65535) {
    throw new GithubActionsOperationContractError("invalid_contract", "Immutable deployment evidence is incomplete.");
  }
}

export function immutableImageTag(commitSha: string, operationId: string) {
  const suffix = operationId.replace(/[^A-Za-z0-9]/g, "").slice(0, 12);
  if (!/^[0-9a-f]{12,40}$/.test(commitSha) || suffix.length !== 12) {
    throw new GithubActionsOperationContractError("invalid_contract", "Immutable image identity is invalid.");
  }
  return `${commitSha.slice(0, 12)}-${suffix}`;
}

export function environmentReferencesBase64(configuration: GithubActionsRuntimeConfiguration | ContractIdentity) {
  if (!("schemaVersion" in configuration)) {
    const publicNames = [...new Set(configuration.ecsPlan.environmentMappings.map((item) => item.name))].sort();
    const secretNames = [...new Set(configuration.ecsPlan.secretMappings.map((item) => item.name))].sort();
    return Buffer.from(JSON.stringify({
      public: publicNames,
      secret: secretNames,
      configurationFingerprint: createHash("sha256").update(JSON.stringify({ public: publicNames, secret: secretNames })).digest("hex"),
    }), "utf8").toString("base64");
  }
  assertRuntimeConfiguration(configuration);
  return Buffer.from(JSON.stringify(canonicalizeRuntimeConfiguration(configuration)), "utf8").toString("base64");
}

export function decodeEnvironmentReferencesBase64(encoded: string) {
  if (!encoded || encoded.length > 512 * 1024 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) {
    throw new GithubActionsOperationContractError("invalid_contract", "Immutable runtime configuration is invalid.");
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
  } catch {
    throw new GithubActionsOperationContractError("invalid_contract", "Immutable runtime configuration is invalid.");
  }
  assertRuntimeConfiguration(decoded as GithubActionsRuntimeConfiguration);
  return canonicalizeRuntimeConfiguration(decoded as GithubActionsRuntimeConfiguration);
}

export function runtimeConfigurationWithPromotionCandidate(
  configuration: GithubActionsRuntimeConfiguration,
  candidate: GithubActionsCandidateEvidence,
) {
  assertRuntimeConfiguration(configuration);
  const { intentFingerprint: _previousFingerprint, ...immutableIntent } = configuration.promotion;
  const intentWithoutFingerprint: Omit<PromotionIntent, "intentFingerprint"> = {
    ...immutableIntent,
    candidate,
  };
  const promoted: GithubActionsRuntimeConfiguration = {
    ...configuration,
    promotion: {
      ...intentWithoutFingerprint,
      intentFingerprint: promotionIntentFingerprint(intentWithoutFingerprint),
    },
  };
  assertRuntimeConfiguration(promoted);
  return promoted;
}

function canonicalizeRuntimeConfiguration(configuration: GithubActionsRuntimeConfiguration): GithubActionsRuntimeConfiguration {
  const sort = <T extends string>(value: Record<string, T>) => Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right))) as Record<string, T>;
  return {
    ...configuration,
    environment: sort(configuration.environment),
    secretReferences: sort(configuration.secretReferences),
    retentionProtectedRelease: {
      imageDigests: [...new Set(configuration.retentionProtectedRelease.imageDigests)].sort(),
      taskDefinitionArns: [...new Set(configuration.retentionProtectedRelease.taskDefinitionArns)].sort(),
    },
    managedDatabase: configuration.managedDatabase ? {
      ...configuration.managedDatabase,
      runtimeAliases: sort(configuration.managedDatabase.runtimeAliases),
      secretAliases: sort(configuration.managedDatabase.secretAliases),
    } : null,
  };
}

function assertRuntimeConfiguration(configuration: GithubActionsRuntimeConfiguration) {
  const validRecord = (value: unknown, predicate: (item: string) => boolean) => Boolean(
    value && typeof value === "object" && !Array.isArray(value)
    && Object.entries(value as Record<string, unknown>).every(([key, item]) => CONFIGURATION_KEY.test(key) && typeof item === "string" && predicate(item)),
  );
  const promotion = configuration?.promotion;
  let promotionFingerprintValid = promotion?.candidate === null && promotion?.intentFingerprint === null;
  if (promotion?.candidate && promotion.intentFingerprint) {
    const { intentFingerprint: _storedFingerprint, ...fingerprintInput } = promotion;
    promotionFingerprintValid = promotion.intentFingerprint === promotionIntentFingerprint(fingerprintInput);
  }
  if (!configuration || typeof configuration !== "object" || Array.isArray(configuration)
    || configuration.schemaVersion !== 1
    || !UUID.test(configuration.configurationSnapshotId)
    || !FINGERPRINT.test(configuration.configurationFingerprint)
    || !UUID.test(configuration.projectId)
    || !UUID.test(configuration.generationId)
    || configuration.generationStateKey !== `projects/${configuration.projectId}/${configuration.environmentName}/${configuration.generationId}/terraform.tfstate`
    || !configuration.platformFoundation
    || configuration.platformFoundation.vpcId.length === 0
    || !Array.isArray(configuration.platformFoundation.publicSubnetIds)
    || configuration.platformFoundation.publicSubnetIds.length < 2
    || !configuration.platformFoundation.ecsClusterArn.startsWith("arn:")
    || !configuration.platformFoundation.ecsClusterName
    || !configuration.platformFoundation.albArn.startsWith("arn:")
    || !configuration.platformFoundation.albDnsName
    || !configuration.platformFoundation.listenerArn.startsWith("arn:")
    || !configuration.platformFoundation.albSecurityGroupId
    || !configuration.routing
    || !Number.isInteger(configuration.routing.listenerPriority)
    || configuration.routing.listenerPriority < 1000
    || configuration.routing.listenerPriority > 19999
    || !Number.isInteger(configuration.routing.verificationPriority)
    || configuration.routing.verificationPriority < 20000
    || configuration.routing.verificationPriority > 50000
    || !/^[a-z0-9.-]+$/.test(configuration.routing.productionHost)
    || !/^[a-z0-9.-]+$/.test(configuration.routing.candidateHost)
    || !configuration.projectPersistence
    || configuration.projectPersistence.stateKey !== `projects/${configuration.projectId}/${configuration.environmentName}/project/terraform.tfstate`
    || configuration.projectPersistence.ecrRepositoryName !== `deployguard-${configuration.projectId}`
    || configuration.projectPersistence.runtimeSecretName !== `deployguard/${configuration.projectId}/${configuration.environmentName}/application/runtime`
    || configuration.projectPersistence.ownershipScope !== "project"
    || (configuration.retiredGenerationCleanup !== null && (
      !UUID.test(configuration.retiredGenerationCleanup.generationId)
      || configuration.retiredGenerationCleanup.generationId === configuration.generationId
      || configuration.retiredGenerationCleanup.terraformStateKey !== `projects/${configuration.projectId}/${configuration.environmentName}/${configuration.retiredGenerationCleanup.generationId}/terraform.tfstate`
      || !configuration.retiredGenerationCleanup.resourceManifest
      || typeof configuration.retiredGenerationCleanup.resourceManifest !== "object"
      || Array.isArray(configuration.retiredGenerationCleanup.resourceManifest)
    ))
    || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(configuration.environmentName)
    || !validRecord(configuration.environment, (value) => Buffer.byteLength(value) <= 4096 && !/[\r\n\0]/.test(value))
    || !validRecord(configuration.secretReferences, (value) => SECRET_VALUE_FROM.test(value))
    || !configuration.retentionProtectedRelease
    || !Array.isArray(configuration.retentionProtectedRelease.imageDigests)
    || configuration.retentionProtectedRelease.imageDigests.length > 10
    || configuration.retentionProtectedRelease.imageDigests.some((value) => !/^sha256:[0-9a-f]{64}$/.test(value))
    || !Array.isArray(configuration.retentionProtectedRelease.taskDefinitionArns)
    || configuration.retentionProtectedRelease.taskDefinitionArns.length > 10
    || configuration.retentionProtectedRelease.taskDefinitionArns.some((value) => !/^arn:(?:aws|aws-us-gov|aws-cn):ecs:[a-z0-9-]+:\d{12}:task-definition\/[A-Za-z0-9_-]+:\d+$/.test(value))
    || !configuration.promotion
    || configuration.promotion.contractVersion !== "deployguard.promotion-intent/v1"
    || !UUID.test(configuration.promotion.operationId)
    || configuration.promotion.projectId !== configuration.projectId
    || configuration.promotion.environmentName !== configuration.environmentName
    || configuration.promotion.generationId !== configuration.generationId
    || (configuration.promotion.previousLiveGenerationId !== null && !UUID.test(configuration.promotion.previousLiveGenerationId))
    || (configuration.promotion.previousTargetGroupArn !== null && !configuration.promotion.previousTargetGroupArn.startsWith("arn:"))
    || (configuration.promotion.previousListenerRuleArn !== null && !configuration.promotion.previousListenerRuleArn.startsWith("arn:"))
    || (configuration.promotion.previousProductionUrl !== null && !/^https?:\/\//.test(configuration.promotion.previousProductionUrl))
    || !promotionFingerprintValid
    || (configuration.promotion.candidate !== null && (
      !isGithubActionsCandidateEvidence(configuration.promotion.candidate)
      || configuration.promotion.candidate.deploymentOperationId !== configuration.promotion.operationId
      || configuration.promotion.candidate.projectId !== configuration.projectId
      || configuration.promotion.candidate.environmentName !== configuration.environmentName
      || configuration.promotion.candidate.generationId !== configuration.generationId
    ))
    || !isDispatchableDeploymentRecoveryDecision(configuration.deploymentContext)) {
    throw new GithubActionsOperationContractError("invalid_contract", "Immutable runtime configuration is invalid.");
  }
  const database = configuration.managedDatabase;
  const databaseProfile = managedDatabaseProfile(database?.engine);
  const hasExplicitProfile = database !== null && [
    database.image,
    database.dataPath,
    database.healthCheck,
    database.initializationEnvironment,
    database.initializationSecretNames,
    database.urlScheme,
    database.urlQuery,
  ].some((value) => value !== undefined);
  if (database !== null && (
    !UUID.test(database.bindingId)
    || !FINGERPRINT.test(database.bindingFingerprint)
    || database.provider !== "managed"
    || !databaseProfile
    || !database.host || /^(?:localhost|127\.|0\.0\.0\.0|::1)/i.test(database.host)
    || !Number.isInteger(database.port) || database.port !== databaseProfile.port
    || !database.databaseName || !database.databaseUser
    || database.persistenceEnabled !== true
    || !validRecord(database.runtimeAliases, (value) => Buffer.byteLength(value) <= 4096 && !/[\r\n\0]/.test(value))
    || !validRecord(database.secretAliases, (value) => value === "password" || value === "url")
    || (hasExplicitProfile && (
      database.image !== databaseProfile.image
      || database.dataPath !== databaseProfile.dataPath
      || JSON.stringify(database.healthCheck) !== JSON.stringify(databaseProfile.healthCheck)
      || JSON.stringify(database.initializationEnvironment) !== JSON.stringify(databaseProfile.initializationEnvironment)
      || JSON.stringify(database.initializationSecretNames) !== JSON.stringify(databaseProfile.initializationSecretNames)
      || database.urlScheme !== databaseProfile.urlScheme
      || database.urlQuery !== databaseProfile.urlQuery
    ))
  )) {
    throw new GithubActionsOperationContractError("invalid_contract", "Immutable managed database configuration is invalid.");
  }
}

export function immutableDispatchFingerprint(inputs: GithubActionsOperationInputs) {
  return fingerprintInputs(GITHUB_ACTIONS_INPUT_NAMES, inputs);
}

export function requireRetryInputs(
  metadata: Record<string, unknown> | null,
  expected: { operationId: string; projectId: string; repositoryFullName: string; targetBranch: string; commitSha: string },
) {
  const candidate = metadata?.immutableDispatchInputs;
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new GithubActionsOperationContractError("immutable_snapshot_missing", "This operation predates immutable retry snapshots and cannot be retried safely.");
  }
  const record = candidate as Record<string, unknown>;
  if (PRE_ROLLBACK_INPUT_NAMES.some((name) => typeof record[name] !== "string")) {
    throw new GithubActionsOperationContractError("immutable_snapshot_tampered", "The immutable retry snapshot is incomplete.");
  }
  const missingRollbackInputs = ROLLBACK_INPUT_NAMES.some((name) => record[name] === undefined);
  if (ROLLBACK_INPUT_NAMES.some((name) => record[name] !== undefined && typeof record[name] !== "string")) {
    throw new GithubActionsOperationContractError("immutable_snapshot_tampered", "The immutable retry snapshot is incomplete.");
  }
  const inputs = missingRollbackInputs
    ? Object.fromEntries(
        GITHUB_ACTIONS_INPUT_NAMES.map((name) => [name, typeof record[name] === "string" ? record[name] : ""]),
      ) as GithubActionsOperationInputs
    : record as GithubActionsOperationInputs;
  const storedFingerprint = metadata?.immutableDispatchFingerprint;
  const fingerprintMatches = typeof storedFingerprint === "string" && (
    storedFingerprint === immutableDispatchFingerprint(inputs)
    || (missingRollbackInputs && storedFingerprint === fingerprintInputs(PRE_ROLLBACK_INPUT_NAMES, record as Record<GithubActionsOperationInputName, string>))
  );
  if (!fingerprintMatches) {
    throw new GithubActionsOperationContractError("immutable_snapshot_tampered", "The immutable retry snapshot failed integrity verification.");
  }
  if (inputs.deployment_operation_id !== expected.operationId || inputs.project_id !== expected.projectId) {
    throw new GithubActionsOperationContractError("cross_project_contract", "The immutable retry snapshot does not belong to this operation.");
  }
  if (inputs.repository_full_name !== expected.repositoryFullName) {
    throw new GithubActionsOperationContractError("wrong_repository", "The immutable retry snapshot belongs to a different repository.");
  }
  if (inputs.repository_branch !== expected.targetBranch) {
    throw new GithubActionsOperationContractError("wrong_branch", "The immutable retry snapshot belongs to a different branch.");
  }
  if (inputs.commit_sha !== expected.commitSha) {
    throw new GithubActionsOperationContractError("stale_commit", "Retry cannot change the operation commit.");
  }
  return inputs;
}

export type RetryOperationEligibility = "immutable_snapshot" | "undispatched_destroy_recovery" | "ineligible";

export function retryOperationEligibility(
  operation: {
    id: string;
    projectId: string;
    repositoryFullName: string;
    targetBranch: string;
    commitSha: string;
    currentStage: string;
    githubWorkflowRunId?: string | null;
    githubWorkflowStatus?: string | null;
    metadata: Record<string, unknown> | null;
  },
  project: { id: string; repositoryFullName: string; targetBranch: string },
): RetryOperationEligibility {
  try {
    requireRetryInputs(operation.metadata, {
      operationId: operation.id,
      projectId: project.id,
      repositoryFullName: project.repositoryFullName,
      targetBranch: project.targetBranch,
      commitSha: operation.commitSha,
    });
    return "immutable_snapshot";
  } catch {
    const metadata = operation.metadata || {};
    const snapshotMissing = metadata.immutableDispatchInputs === undefined
      && metadata.immutableDispatchFingerprint === undefined;
    const undispatchedDestroy = metadata.deploymentAction === "destroy"
      && snapshotMissing
      && !operation.githubWorkflowRunId
      && ["workflow_dispatch", "workflow_run_discovery"].includes(operation.currentStage)
      && ["dispatching", "dispatch_failed", "dispatch_interrupted", "not_dispatched", "run_not_found"].includes(String(operation.githubWorkflowStatus || ""));
    return undispatchedDestroy ? "undispatched_destroy_recovery" : "ineligible";
  }
}

function fingerprintInputs(
  names: readonly GithubActionsOperationInputName[],
  inputs: Record<GithubActionsOperationInputName, string>,
) {
  return createHash("sha256").update(JSON.stringify(names.map((name) => [name, inputs[name]]))).digest("hex");
}
