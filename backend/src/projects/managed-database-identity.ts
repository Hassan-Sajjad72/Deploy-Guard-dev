import { createHash } from "node:crypto";

const identityPrefix = (value: string) => value
  .toLowerCase()
  .replaceAll("_", "-")
  .slice(0, 8);

/**
 * Keep this formula byte-for-byte compatible with the Terraform expression in
 * deployguard-reusable.yml. EFS creation tokens are limited to 64 characters.
 */
export function managedDatabaseEfsCreationToken(projectId: string, environmentName: string) {
  const digest = createHash("sha256")
    .update(`${projectId}:${environmentName}:project-persistence`, "utf8")
    .digest("hex")
    .slice(0, 40);
  return `dg-efs-${identityPrefix(projectId)}-${digest}`;
}

export const MANAGED_DATABASE_PERSISTENCE_TAG = "project";
