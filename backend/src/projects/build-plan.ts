export const BUILD_PLAN_VERSION = 1 as const;
export const BUILD_PLAN_DETECTOR_VERSION = "mainstream-detectors-v3";
export const BUILD_PLAN_REANALYSIS_MESSAGE = "Repository analysis changed. Run Detect Stack again before deploying.";

export type BuildPlanEnvironmentOwnership = {
  key: string;
  owner: "application" | "repository" | "platform" | "infrastructure";
  component?: "frontend" | "backend" | "application" | "platform";
  source?: "application" | "repository" | "platform" | "managed_database";
  exposure?: "public" | "private";
  requirement?: "required" | "optional" | "unknown";
  required: boolean;
  phase: "build" | "runtime";
  secret: boolean;
  repositoryValue?: string;
};

export type BuildPlanComponent = {
  id: "frontend" | "backend" | "application";
  role: "frontend" | "backend" | "application";
  root: string;
  buildContext: string;
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
  installCommand: string;
  buildCommand: string | null;
  runCommand: string | null;
  runtimeFiles: string[];
  outputDirectory: string | null;
  port: number;
  healthPath: string;
  bindHost: string | null;
  bindsToPortEnv: boolean;
  dockerStrategy: "generated" | "custom";
  dockerTemplate: string;
  environmentOwnership: BuildPlanEnvironmentOwnership[];
  database: {
    required: boolean;
    provider: "managed" | "none";
    engine: "postgres" | "mysql" | "mongodb" | null;
  };
};

export type BuildPlanComponentRelationship = {
  from: "frontend";
  to: "backend";
  kind: "http";
  mode: "same-origin" | "build-time-url";
  pathPrefix: string;
  stripPathPrefix: boolean;
  buildTimeVariable: string | null;
  verificationPath: string;
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
  evidence: Array<{ source: string; description: string }>;
  appRoot: string;
  repositoryInstallRoot: string;
  packageManager: string;
  dependencyManifest: string;
  lockfile: string | null;
  runtimeVersion: string;
  baseImage: string;
  runtimeImage: string;
  installCommand: string;
  buildCommand: string | null;
  buildCommands: string[];
  releaseCommand: string | null;
  releaseCommands: string[];
  runCommand: string | null;
  runtimeFiles: string[];
  outputDirectory: string | null;
  buildSystemDependencies: string[];
  runtimeSystemDependencies: string[];
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
  dockerTemplate: string;
  warnings: string[];
  blockers: string[];
  /**
   * New analyses always persist the complete bounded component inventory.
   * Optionality is retained only so already-persisted single-component v1
   * contracts remain readable until their next repository analysis.
   */
  components?: BuildPlanComponent[];
  relationships?: BuildPlanComponentRelationship[];
};

export function buildPlanComponents(plan: BuildPlan): BuildPlanComponent[] {
  if (Array.isArray(plan.components) && plan.components.length > 0) return plan.components;
  return [{
    id: "application",
    role: "application",
    root: plan.appRoot,
    buildContext: plan.appRoot,
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
    installCommand: plan.installCommand,
    buildCommand: plan.buildCommand,
    runCommand: plan.runCommand,
    runtimeFiles: plan.runtimeFiles,
    outputDirectory: plan.outputDirectory,
    port: plan.port,
    healthPath: plan.healthPath,
    bindHost: plan.bindHost,
    bindsToPortEnv: plan.bindsToPortEnv,
    dockerStrategy: plan.dockerStrategy,
    dockerTemplate: plan.dockerTemplate,
    environmentOwnership: plan.environmentOwnership,
    database: plan.database || { required: false, provider: "none", engine: null },
  }];
}

export function requireBuildPlan(value: { buildPlan?: BuildPlan | null }): BuildPlan {
  const plan = value.buildPlan;
  if (!plan || plan.planVersion !== BUILD_PLAN_VERSION || plan.detectorVersion !== BUILD_PLAN_DETECTOR_VERSION) {
    throw new Error(BUILD_PLAN_REANALYSIS_MESSAGE);
  }
  return plan;
}
