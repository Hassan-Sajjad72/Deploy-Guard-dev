import { createHash } from "crypto";
import { normalizeServiceDirectory } from "./deployable-service-path";

/** Immutable, source-SHA scoped build admission owned by DeployGuard. */
export const BUILD_TARGET_RESOLVER_VERSION = "deployguard.build-target/v2";
export type BuildTargetStatus = "resolved" | "ambiguous" | "unsupported" | "invalid";
export type BuildTargetStrategy = "isolated" | "workspace" | "python_local" | "override";
export type DeploymentContract = "JS_STANDALONE" | "JS_WORKSPACE_MEMBER" | "PYTHON_STANDALONE";
export type BuildTargetExecution = {
  packageTarget: string | null;
  packageManager: "npm" | "pnpm" | "yarn" | "bun" | null;
  buildCommand: string | null;
  startCommand: string | null;
};
export type BuildTargetOverride = {
  buildRoot?: string;
  workspaceRoot?: string;
  installRoot?: string;
  selectedPackage?: string;
  buildCommand?: string;
  startCommand?: string;
  railpackConfigPath?: string;
};
export type CanonicalBuildTarget = {
  resolverVersion: string;
  sourceSha: string;
  serviceDirectory: string;
  workspaceRoot: string;
  buildRoot: string;
  installRoot: string;
  packageIdentity: string | null;
  contract: DeploymentContract;
  execution: BuildTargetExecution;
  dependencyPaths: string[];
  strategy: BuildTargetStrategy;
  status: BuildTargetStatus;
  evidence: Record<string, unknown>;
  override: BuildTargetOverride | null;
  fingerprint: string;
};

export function canonicalBuildTarget(value: Omit<CanonicalBuildTarget, "fingerprint">): CanonicalBuildTarget {
  const normalized = {
    ...value,
    serviceDirectory: normalizeServiceDirectory(value.serviceDirectory),
    workspaceRoot: normalizeServiceDirectory(value.workspaceRoot),
    buildRoot: normalizeServiceDirectory(value.buildRoot),
    installRoot: normalizeServiceDirectory(value.installRoot),
    execution: {
      packageTarget: value.execution.packageTarget,
      packageManager: value.execution.packageManager,
      buildCommand: value.execution.buildCommand,
      startCommand: value.execution.startCommand,
    },
    dependencyPaths: [...new Set(value.dependencyPaths.map(normalizeServiceDirectory))].sort(),
    override: value.override ? Object.fromEntries(Object.entries(value.override).sort(([a], [b]) => a.localeCompare(b))) : null,
  };
  return { ...normalized, fingerprint: createHash("sha256").update(JSON.stringify(normalized)).digest("hex") };
}

export function assertBuildTargetOverride(value: unknown): BuildTargetOverride | null {
  if (value == null) return null;
  throw new Error("Build-target overrides are unsupported by the DeployGuard v1 deployment contract.");
}
