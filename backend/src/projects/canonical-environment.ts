export const DEFAULT_DEPLOYMENT_ENVIRONMENT = "dev";

const ENVIRONMENT_NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;

export type EnvironmentIdentity = { environmentName?: string | null };

/**
 * A project's environment name is immutable after creation and is the only
 * environment identifier allowed to cross DeployGuard stages.
 */
export function canonicalEnvironmentName(project: EnvironmentIdentity): string {
  const value = String(project.environmentName || DEFAULT_DEPLOYMENT_ENVIRONMENT).trim();
  if (!ENVIRONMENT_NAME.test(value)) throw new Error("Project has an invalid immutable environment identifier.");
  return value;
}
