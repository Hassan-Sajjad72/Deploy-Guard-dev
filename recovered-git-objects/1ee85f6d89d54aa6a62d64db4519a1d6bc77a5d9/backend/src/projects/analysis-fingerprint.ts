import { createHash } from "crypto";
import { ProjectDetectionProfile } from "./project-detection-profile.entity";
import { Project } from "./project.entity";

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function analysisFingerprint(value: Record<string, unknown>) {
  return createHash("sha256").update(stable(value)).digest("hex");
}

export function detectionFingerprint(project: Project, commitSha: string | null) {
  return analysisFingerprint({
    version: 2,
    repository: project.repositoryFullName || project.repositoryUrl,
    repositoryUrl: project.repositoryUrl,
    targetBranch: project.targetBranch,
    commitSha,
    appDirectory: project.appDirectory || ".",
    deploymentOverrides: project.deploymentOverrides || {},
  });
}

export function preflightFingerprint(
  project: Project,
  profile: ProjectDetectionProfile,
  environmentVariables: Array<{ key: string; isSecret: boolean }>
) {
  return analysisFingerprint({
    version: 2,
    detectionFingerprint: profile.inputFingerprint,
    commitSha: profile.commitSha,
    selectedTemplate: profile.selectedTemplate,
    appDirectory: project.appDirectory || ".",
    deploymentOverrides: project.deploymentOverrides || {},
    environmentVariables: environmentVariables
      .map((item) => ({ key: item.key, isSecret: item.isSecret }))
      .sort((left, right) => left.key.localeCompare(right.key)),
  });
}
