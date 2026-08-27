export type ReadinessWarningDetail = {
  code: string;
  severity: "warning";
  scope: "application" | "platform";
  deploymentAllowed: true;
  message: string;
};

export const APPLICATION_FILESYSTEM_EPHEMERAL = "APPLICATION_FILESYSTEM_EPHEMERAL" as const;

export const READINESS_WARNING_CODES = [
  APPLICATION_FILESYSTEM_EPHEMERAL,
  "DEPENDENCY_LOCKFILE_MISSING",
  "PRIVATE_REGISTRY_CONFIGURATION",
  "PLATFORM_RUNTIME_EXECUTABLE_INJECTED",
  "HEALTH_ENDPOINT_FALLBACK",
  "FRAMEWORK_DEFAULT_PORT",
  "RUNTIME_VERSION_UNPINNED",
  "OPTIONAL_CONFIGURATION_MISSING",
  "ENV_REQUIREDNESS_UNPROVEN",
  "HEALTH_ENDPOINT_REVIEW",
  "APPLICATION_ANALYSIS_WARNING",
] as const;

export const APPLICATION_FILESYSTEM_EPHEMERAL_MESSAGE = [
  "Application filesystem persistence detected.",
  "This application writes runtime data to the container filesystem. DeployGuard can deploy the application, but application-owned local data may be lost when containers restart, redeploy, scale, or are replaced.",
  "DeployGuard does not guarantee durability of application-owned container filesystem data.",
].join(" ");

export function applicationFilesystemEphemeralWarning(): ReadinessWarningDetail {
  return {
    code: APPLICATION_FILESYSTEM_EPHEMERAL,
    severity: "warning",
    scope: "application",
    deploymentAllowed: true,
    message: APPLICATION_FILESYSTEM_EPHEMERAL_MESSAGE,
  };
}

const WARNING_RULES: Array<{ code: string; scope: ReadinessWarningDetail["scope"]; pattern: RegExp }> = [
  { code: APPLICATION_FILESYSTEM_EPHEMERAL, scope: "application", pattern: /^Application filesystem persistence detected\./ },
  { code: "DEPENDENCY_LOCKFILE_MISSING", scope: "application", pattern: /^No (?:JavaScript|Python) lockfile/ },
  { code: "PRIVATE_REGISTRY_CONFIGURATION", scope: "application", pattern: /^Private (?:npm|Python package) registry configuration detected/ },
  { code: "PLATFORM_RUNTIME_EXECUTABLE_INJECTED", scope: "platform", pattern: /^DeployGuard will supply the pinned (?:Gunicorn|Uvicorn)/ },
  { code: "HEALTH_ENDPOINT_FALLBACK", scope: "application", pattern: /^No explicit health endpoint was detected/ },
  { code: "FRAMEWORK_DEFAULT_PORT", scope: "application", pattern: /^Using framework default port/ },
  { code: "RUNTIME_VERSION_UNPINNED", scope: "application", pattern: /^No (?:Node\.js|Python) version is pinned/ },
  { code: "OPTIONAL_CONFIGURATION_MISSING", scope: "application", pattern: /^Optional environment variables are not configured/ },
  { code: "ENV_REQUIREDNESS_UNPROVEN", scope: "application", pattern: /^Configuration requiredness could not be proven/ },
  { code: "HEALTH_ENDPOINT_REVIEW", scope: "application", pattern: /^Verify that the (?:Python|PHP) application exposes \/health/ },
];

export function readinessWarningDetails(messages: string[], existing: ReadinessWarningDetail[] = []): ReadinessWarningDetail[] {
  const details = [...existing];
  for (const message of messages) {
    if (!message || details.some((item) => item.message === message)) continue;
    const rule = WARNING_RULES.find((item) => item.pattern.test(message));
    details.push({
      code: rule?.code || "APPLICATION_ANALYSIS_WARNING",
      severity: "warning",
      scope: rule?.scope || "application",
      deploymentAllowed: true,
      message,
    });
  }
  return details.filter((item, index, items) => items.findIndex((candidate) => candidate.code === item.code && candidate.message === item.message) === index);
}
