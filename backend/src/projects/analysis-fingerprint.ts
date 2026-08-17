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

export function deploymentContractFingerprint(
  value: Record<string, any>,
) {
  const sortedStrings = (items: unknown) =>
    Array.isArray(items) ? [...new Set(items.map(String))].sort() : [];
  const sortedMappings = (items: unknown) =>
    Array.isArray(items)
      ? items
          .map((item) => ({
            name: String(item?.name || ""),
            source: String(item?.source || ""),
          }))
          .filter((item) => item.name)
          .sort((left, right) =>
            `${left.name}:${left.source}`.localeCompare(
              `${right.name}:${right.source}`,
            ),
          )
      : [];
  const ecsPlan = value.ecsPlan || {};
  const database = ecsPlan.database || {};

  return analysisFingerprint({
    schemaVersion: 3,
    buildPlan: value.buildPlan || null,
    repositoryFullName: value.repositoryFullName || null,
    branch: value.branch,
    commitSha: value.commitSha || null,
    appRoot: value.appRoot || ".",
    language: value.language || null,
    framework: value.framework || null,
    runtimeType: value.runtimeType || null,
    packageManager: value.packageManager || null,
    dependencyManifest: value.dependencyManifest || null,
    lockfile: value.lockfile || null,
    nodeVersion: value.nodeVersion || null,
    pythonVersion: value.pythonVersion || null,
    installCommand: value.installCommand || null,
    buildCommand: value.buildCommand || null,
    startCommand: value.startCommand || null,
    outputDirectory: value.outputDirectory || null,
    port: value.port ?? null,
    portSource: value.portSource || null,
    bindsToPortEnv: value.bindsToPortEnv === true,
    bindHost: value.bindHost || null,
    healthPath: value.healthPath || "/",
    requiredEnvVars: sortedStrings(value.requiredEnvVars),
    optionalEnvVars: sortedStrings(value.optionalEnvVars),
    buildTimeEnvVars: sortedStrings(value.buildTimeEnvVars),
    runtimeEnvVars: sortedStrings(value.runtimeEnvVars),
    secretEnvVars: sortedStrings(value.secretEnvVars),
    databaseRequired: value.databaseRequired === true,
    databaseEngine: value.databaseEngine || null,
    persistentStorageRequired: value.persistentStorageRequired === true,
    privateRegistryRequired: value.privateRegistryRequired === true,
    dockerStrategy: value.dockerStrategy || null,
    dockerTemplate: value.dockerTemplate || null,
    overridesHash: value.overridesHash || null,
    ecsPlan: {
      containerPort: ecsPlan.containerPort ?? null,
      targetGroupPort: ecsPlan.targetGroupPort ?? null,
      healthCheckPath: ecsPlan.healthCheckPath || "/",
      command: ecsPlan.command || null,
      cpu: ecsPlan.cpu ?? null,
      memory: ecsPlan.memory ?? null,
      environmentMappings: sortedMappings(ecsPlan.environmentMappings),
      secretMappings: sortedMappings(ecsPlan.secretMappings),
      logGroups: {
        app: ecsPlan.logGroups?.app || null,
        database: ecsPlan.logGroups?.database || null,
        deployment: ecsPlan.logGroups?.deployment || null,
      },
      database: {
        required: database.required === true,
        provider: database.provider || null,
        engine: database.engine || null,
        host: database.host || null,
        port: database.port ?? null,
        databaseName: database.databaseName || null,
        databaseUser: database.databaseUser || null,
        image: database.image || null,
        dataPath: database.dataPath || null,
        persistenceEnabled: database.persistenceEnabled === true,
      },
    },
  });
}

export function detectionFingerprint(project: Project, commitSha: string | null) {
  return analysisFingerprint({
    version: 3,
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
