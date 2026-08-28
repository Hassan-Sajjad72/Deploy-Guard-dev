import type { ReadinessWarningDetail } from "./readiness-warning";

export const BUILD_PLAN_VERSION = 2 as const;
export const BUILD_PLAN_DETECTOR_VERSION = "retired-topology-v5";
export const BUILD_PLAN_REANALYSIS_MESSAGE = "Repository analysis changed. Run Detect Stack again before deploying.";

export type BuildPlanEnvironmentOwnership = {
  key: string;
  owner: "application" | "repository" | "platform" | "infrastructure";
  component?: "frontend" | "backend" | "application" | "platform";
  /** Exact BuildPlan component which consumes this value at runtime. */
  componentId?: "frontend" | "backend" | "application";
  source?: "application" | "repository" | "platform" | "managed_database";
  exposure?: "public" | "private";
  requirement?: "required" | "optional" | "unknown";
  required: boolean;
  phase: "build" | "runtime";
  secret: boolean;
  repositoryValue?: string;
};

export type BuildPlanImageFamily = {
  distro: "alpine" | "debian";
  packageManager: "apk" | "apt";
};

/**
 * Describes the limited configuration that a generated image may receive
 * while executing a build command which imports the application itself.
 * Runtime-managed services deliberately remain unavailable at image-build
 * time: a syntactically valid, non-secret placeholder is used only where a
 * framework needs to import settings without connecting to that service.
 */
export type BuildInitialization = {
  contractVersion: "deployguard.build-initialization/v1";
  mode: "none" | "runtime_placeholders" | "external_service_required";
  reason: string;
};

export type BuildPlanComponent = {
  id: "frontend" | "backend" | "application";
  role: "frontend" | "backend" | "application";
  root: string;
  buildContext: string;
  /** Canonical dependency-install root; this may deliberately differ from app root/build context in a workspace. */
  repositoryInstallRoot: string;
  detectorId: string;
  language: "javascript" | "python" | "static";
  framework: string;
  frameworkMode: string;
  runtimeType: "static" | "server";
  packageManager: string;
  dependencyManifest: string;
  lockfile: string | null;
  runtimeVersion: string;
  baseImage: string;
  runtimeImage: string;
  buildImageFamily?: BuildPlanImageFamily;
  runtimeImageFamily?: BuildPlanImageFamily;
  installCommand: string;
  buildSystemDependencies?: string[];
  runtimeSystemDependencies?: string[];
  systemDependencyEvidence?: { build: string[]; runtime: string[] };
  buildCommand: string | null;
  buildInitialization?: BuildInitialization;
  releaseCommand?: string | null;
  runCommand: string | null;
  runtimeFiles: string[];
  outputDirectory: string | null;
  port: number;
  healthPath: string | null;
  healthCheckMode?: "http" | "tcp";
  bindHost: string | null;
  bindsToPortEnv: boolean;
  dockerStrategy: "generated" | "custom";
  dockerfilePath?: string;
  dockerTemplate: string;
  environmentOwnership: BuildPlanEnvironmentOwnership[];
  database: {
    required: boolean;
    provider: "managed" | "none";
    engine: "postgres" | "mysql" | "mongodb" | null;
  };
  persistentStorageRequired?: boolean;
};

export type BuildPlanComponentRelationship = {
  from: "frontend";
  to: "backend";
  kind: "http";
  mode: "same-origin" | "build-time-url";
  pathPrefix: string;
  stripPathPrefix: boolean;
  buildTimeVariable: string | null;
  verificationPath: string | null;
};

/**
 * A provider-owned browser configuration binding.  It is intentionally
 * separate from optional route-discovery evidence: DeployGuard strips only
 * platformPathPrefix and preserves the application pathname exactly.
 */
export type BuildPlanServiceBinding = {
  sourceComponent: "frontend";
  envAlias: string;
  targetComponent: "backend";
  bindingMode: "platform-proxy";
  preservedPathname: string | null;
  platformPathPrefix: string;
};

export type BuildPlan = {
  planVersion: typeof BUILD_PLAN_VERSION;
  detectorVersion: string;
  repositoryFullName: string;
  branch: string;
  commitSha: string;
  detectorId: string;
  language: "javascript" | "python";
  framework: string;
  frameworkMode: string;
  confidence: string;
  /** Canonical platform-owned browser-to-backend mount for this plan. */
  platformBackendMount?: string;
  evidence: Array<{ source: string; description: string }>;
  appRoot: string;
  repositoryInstallRoot: string;
  packageManager: string;
  dependencyManifest: string;
  lockfile: string | null;
  runtimeVersion: string;
  baseImage: string;
  runtimeImage: string;
  buildImageFamily?: BuildPlanImageFamily;
  runtimeImageFamily?: BuildPlanImageFamily;
  installCommand: string;
  buildCommand: string | null;
  buildCommands: string[];
  buildInitialization?: BuildInitialization;
  releaseCommand: string | null;
  releaseCommands: string[];
  runCommand: string | null;
  runtimeFiles: string[];
  outputDirectory: string | null;
  buildSystemDependencies: string[];
  runtimeSystemDependencies: string[];
  systemDependencyEvidence?: { build: string[]; runtime: string[] };
  port: number;
  portSource: string;
  healthPath: string;
  bindHost: string | null;
  bindsToPortEnv: boolean;
  runtimeType: "static" | "server";
  database?: {
    required: boolean;
    provider: "managed" | "none";
    engine: "postgres" | "mysql" | "mongodb" | null;
  };
  environmentOwnership: BuildPlanEnvironmentOwnership[];
  requiredInputs: string[];
  requiredUserInputs: string[];
  optionalInputs: string[];
  buildTimeEnvVars: string[];
  runtimeEnvVars: string[];
  secretEnvVars: string[];
  dockerStrategy: "generated" | "custom";
  dockerfilePath?: string;
  dockerTemplate: string;
  warnings: string[];
  warningDetails?: ReadinessWarningDetail[];
  blockers: string[];
  /**
   * New analyses always persist the complete bounded component inventory.
   * Optionality is retained only so already-persisted single-component v1
   * contracts remain readable until their next repository analysis.
   */
  components?: BuildPlanComponent[];
  relationships?: BuildPlanComponentRelationship[];
  serviceBindings?: BuildPlanServiceBinding[];
  topology?: {
    schemaVersion: 3;
    shape: string;
    analysisState: "SUPPORTED" | "INPUT_REQUIRED" | "UNRESOLVED" | "UNSUPPORTED";
    confidence: "proven" | "bounded" | "unresolved";
    artifacts: Array<{ id: string; root: string; path: string; kind: "static-output"; producedBy: string }>;
    relationships: Array<Record<string, unknown>>;
    serviceBindings: BuildPlanServiceBinding[];
  };
};

export function buildPlanComponents(plan: BuildPlan): BuildPlanComponent[] {
  if (Array.isArray(plan.components) && plan.components.length > 0) return plan.components;
  return [{
    id: "application",
    role: "application",
    root: plan.appRoot,
    buildContext: plan.appRoot,
    repositoryInstallRoot: plan.repositoryInstallRoot,
    detectorId: plan.detectorId,
    language: plan.language,
    framework: plan.framework,
    frameworkMode: plan.frameworkMode,
    runtimeType: plan.runtimeType,
    packageManager: plan.packageManager,
    dependencyManifest: plan.dependencyManifest,
    lockfile: plan.lockfile,
    runtimeVersion: plan.runtimeVersion,
    baseImage: plan.baseImage,
    runtimeImage: plan.runtimeImage,
    buildImageFamily: plan.buildImageFamily,
    runtimeImageFamily: plan.runtimeImageFamily,
    installCommand: plan.installCommand,
    buildSystemDependencies: plan.buildSystemDependencies,
    runtimeSystemDependencies: plan.runtimeSystemDependencies,
    systemDependencyEvidence: plan.systemDependencyEvidence,
    buildCommand: plan.buildCommand,
    ...(plan.buildInitialization ? { buildInitialization: plan.buildInitialization } : {}),
    releaseCommand: plan.releaseCommand,
    runCommand: plan.runCommand,
    runtimeFiles: plan.runtimeFiles,
    outputDirectory: plan.outputDirectory,
    port: plan.port,
    healthPath: plan.healthPath,
    bindHost: plan.bindHost,
    bindsToPortEnv: plan.bindsToPortEnv,
    dockerStrategy: plan.dockerStrategy,
    ...(plan.dockerfilePath ? { dockerfilePath: plan.dockerfilePath } : {}),
    dockerTemplate: plan.dockerTemplate,
    environmentOwnership: plan.environmentOwnership,
    database: plan.database || { required: false, provider: "none", engine: null },
    persistentStorageRequired: false,
  }];
}

export function requireBuildPlan(value: { buildPlan?: BuildPlan | null }): BuildPlan {
  const plan = value.buildPlan;
  if (!plan || plan.planVersion !== BUILD_PLAN_VERSION || plan.detectorVersion !== BUILD_PLAN_DETECTOR_VERSION
    || !/^\/[A-Za-z0-9._~!$&()*+,;=:@%/-]+$/.test(plan.platformBackendMount)
    || !Array.isArray(plan.serviceBindings)) {
    throw new Error(BUILD_PLAN_REANALYSIS_MESSAGE);
  }
  return plan;
}
