import { createHash } from "crypto";
import { normalizeServiceDirectory } from "./deployable-service-path";

/** Immutable, source-SHA scoped build admission owned by DeployGuard. */
export const BUILD_TARGET_RESOLVER_VERSION = "deployguard.build-target/v1";
export type BuildTargetStatus = "resolved" | "ambiguous" | "unsupported" | "invalid";
export type BuildTargetStrategy = "isolated" | "workspace" | "python_local" | "override";
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
    dependencyPaths: [...new Set(value.dependencyPaths.map(normalizeServiceDirectory))].sort(),
    override: value.override ? Object.fromEntries(Object.entries(value.override).sort(([a], [b]) => a.localeCompare(b))) : null,
  };
  return { ...normalized, fingerprint: createHash("sha256").update(JSON.stringify(normalized)).digest("hex") };
}

export function assertBuildTargetOverride(value: unknown): BuildTargetOverride | null {
  if (value == null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Build-target override must be an object.");
  const allowed = new Set(["buildRoot", "workspaceRoot", "installRoot", "selectedPackage", "buildCommand", "startCommand", "railpackConfigPath"]);
  const result: BuildTargetOverride = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!allowed.has(key) || typeof raw !== "string" || !raw.trim() || raw.length > 1024) throw new Error("Build-target override contains an invalid value.");
    if (["buildRoot", "workspaceRoot", "installRoot", "railpackConfigPath"].includes(key)) (result as Record<string, string>)[key] = normalizeServiceDirectory(raw);
    else (result as Record<string, string>)[key] = raw.trim();
  }
  return result;
}
