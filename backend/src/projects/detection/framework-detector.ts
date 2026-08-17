export type DetectorLanguage = "javascript" | "python";
export type DetectorRuntimeType = "static" | "server";

export type DetectorEvidence = {
  source: string;
  description: string;
};

export type ExtractedRepositoryFacts = {
  appPath: string;
  files: Set<string>;
  packageJson: Record<string, any> | null;
  dependencies: Record<string, unknown>;
  scripts: Record<string, unknown>;
  dependencyText: string;
  textFiles: Record<string, string>;
  pythonModules: PythonModuleFacts[];
};

export type PythonModuleFacts = {
  file: string;
  module: string;
  assignments: Array<{ name: string; constructor: string }>;
  functions: Array<{ name: string; returnsConstructor: string | null }>;
};

export type PartialDetectorBuildPlan = {
  runtimeType: DetectorRuntimeType;
  packageManager: string;
  runtimeVersion: string;
  baseImage: string;
  runtimeImage: string;
  buildCommand: string | null;
  releaseCommand: string | null;
  runCommand: string | null;
  outputDirectory: string | null;
  runtimeFiles: string[];
  port: number;
  bindHost: string | null;
  bindsToPortEnv: boolean;
  dockerTemplate: string;
  buildSystemDependencies: string[];
  runtimeSystemDependencies: string[];
};

export type FrameworkDetectorResult = {
  detectorId: string;
  language: DetectorLanguage;
  framework: string;
  frameworkMode: string;
  confidence: number;
  evidence: DetectorEvidence[];
  partialBuildPlan: PartialDetectorBuildPlan;
  warnings: string[];
  requiredUserInputs: string[];
  unsupportedReasons: string[];
};

export interface FrameworkDetector {
  readonly id: string;
  readonly priority: number;
  detect(facts: ExtractedRepositoryFacts): FrameworkDetectorResult | null;
}
