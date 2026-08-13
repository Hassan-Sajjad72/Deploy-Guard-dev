export const BUILD_PLAN_VERSION = 1 as const;
export const BUILD_PLAN_DETECTOR_VERSION = "mainstream-detectors-v3";
export const BUILD_PLAN_REANALYSIS_MESSAGE = "Repository analysis changed. Run Detect Stack again before deploying.";

export type BuildPlanEnvironmentOwnership = {
  key: string;
  owner: "application" | "repository" | "platform" | "infrastructure";
  required: boolean;
  phase: "build" | "runtime";
  secret: boolean;
  repositoryValue?: string;
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
};

export function requireBuildPlan(value: { buildPlan?: BuildPlan | null }): BuildPlan {
  const plan = value.buildPlan;
  if (!plan || plan.planVersion !== BUILD_PLAN_VERSION || plan.detectorVersion !== BUILD_PLAN_DETECTOR_VERSION) {
    throw new Error(BUILD_PLAN_REANALYSIS_MESSAGE);
  }
  return plan;
}
