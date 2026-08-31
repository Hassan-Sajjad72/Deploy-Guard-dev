import { EntityManager } from "typeorm";

/** Serializes current service-scoped configuration changes for one project environment. */
export function projectConfigurationAdvisoryLockKey(projectId: string, environment = "dev") {
  return `project_configuration:${projectId}:${environment}`;
}

export async function acquireProjectConfigurationAdvisoryLock(
  manager: EntityManager,
  projectId: string,
  environment = "dev",
) {
  const key = projectConfigurationAdvisoryLockKey(projectId, environment);
  await manager.query("SELECT pg_advisory_xact_lock(hashtext($1))", [key]);
  return key;
}
