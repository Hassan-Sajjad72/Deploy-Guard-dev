import { createHash, randomUUID } from "crypto";
import type { ProjectPipelineEvent } from "./project-pipeline-event.entity";
import { isCanonicalEnvironmentName } from "./canonical-environment";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const RUNTIME_SECRET_OWNERSHIP_SOURCE = "runtime_secret_ownership";

export type RuntimeSecretOwnershipEvent = {
  phase: "intent" | "owned";
  projectId: string;
  operationId: string;
  serviceId: string;
  environmentName: string;
  secretName: string;
  versionToken: string;
  secretArn?: string;
};

export class RuntimeSecretOwnershipPersistenceError extends Error {
  readonly diagnosticCode = "DG_RUNTIME_SECRET_OWNERSHIP_PERSISTENCE_FAILED";
  constructor(readonly identityValidated = false) { super("DeployGuard could not retain runtime-secret ownership evidence."); }
}

/** Only identifiers enter the existing append-only pipeline event history. */
export function runtimeSecretOwnershipRecord(event: RuntimeSecretOwnershipEvent, scope: {
  projectId: string; operationId: string; environmentName: string; accountId: string; region: string;
}): Partial<ProjectPipelineEvent> {
  if (!event || Object.keys(event).some((key) => !["phase", "projectId", "operationId", "serviceId", "environmentName", "secretName", "versionToken", "secretArn"].includes(key))
    || !UUID.test(scope.projectId) || !UUID.test(scope.operationId) || !UUID.test(event.serviceId)
    || !isCanonicalEnvironmentName(scope.environmentName) || !/^\d{12}$/.test(scope.accountId)
    || !/^[a-z]{2}(?:-[a-z]+)+-\d$/.test(scope.region)
    || event.projectId !== scope.projectId || event.operationId !== scope.operationId || event.environmentName !== scope.environmentName
    || !/^[0-9a-f]{64}$/.test(event.versionToken)
    || event.secretName !== `deployguard/${scope.projectId}/${scope.environmentName}/services/${event.serviceId}/runtime`
    || !["intent", "owned"].includes(event.phase)) throw new RuntimeSecretOwnershipPersistenceError();
  const arnPrefix = `arn:aws:secretsmanager:${scope.region}:${scope.accountId}:secret:${event.secretName}-`;
  if (event.phase === "intent" ? event.secretArn !== undefined
    : typeof event.secretArn !== "string" || !event.secretArn.startsWith(arnPrefix) || !/^[A-Za-z0-9]{6}$/.test(event.secretArn.slice(arnPrefix.length))) {
    throw new RuntimeSecretOwnershipPersistenceError();
  }
  const evidence = {
    contractVersion: "deployguard.runtime-secret-ownership/v1",
    projectId: scope.projectId, operationId: scope.operationId, serviceId: event.serviceId,
    environmentName: scope.environmentName, accountId: scope.accountId, region: scope.region,
    phase: event.phase, secretName: event.secretName, versionToken: event.versionToken,
    ...(event.phase === "owned" ? { secretArn: event.secretArn } : {}),
  };
  return {
    id: randomUUID(), projectId: scope.projectId, pipelineRunId: scope.operationId,
    stage: "runtime_secret_materialization", status: event.phase,
    message: event.phase === "intent" ? "Runtime-secret ownership intent retained." : "Exact owned runtime-secret identity retained.",
    source: RUNTIME_SECRET_OWNERSHIP_SOURCE,
    metadata: { evidence, sha256: createHash("sha256").update(JSON.stringify(evidence, Object.keys(evidence).sort())).digest("hex") },
  };
}

/** Restore exact physical identities from complete, integrity-checked pairs.
 * An intent is never converted to ownership by name or by presumed creation.
 */
export function restoreRuntimeSecretOwnership(
  rows: Array<Pick<ProjectPipelineEvent, "pipelineRunId" | "projectId" | "source" | "metadata">>,
  scope: { projectId: string; operationId: string; environmentName: string; accountId: string; region: string },
  operations: ReadonlySet<string> = new Set([scope.operationId]),
): Set<string> {
  const invalid = (): never => { throw new RuntimeSecretOwnershipPersistenceError(); };
  const intents = new Set<string>();
  const owned = new Set<string>();
  const secrets = new Set<string>();
  if (rows.length > 1000) invalid();
  for (const row of rows) {
    const evidence = row.metadata?.evidence;
    if (row.source !== RUNTIME_SECRET_OWNERSHIP_SOURCE || row.projectId !== scope.projectId || !operations.has(row.pipelineRunId)
      || !evidence || typeof evidence !== "object" || Array.isArray(evidence)) invalid();
    const value = evidence as Record<string, unknown>;
    if (value.contractVersion !== "deployguard.runtime-secret-ownership/v1"
      || Object.keys(value).some((key) => !["contractVersion", "projectId", "operationId", "serviceId", "environmentName", "accountId", "region", "phase", "secretName", "versionToken", "secretArn"].includes(key))
      || value.operationId !== row.pipelineRunId || value.accountId !== scope.accountId || value.region !== scope.region) invalid();
    const retained = runtimeSecretOwnershipRecord({ phase: value.phase, projectId: value.projectId, operationId: value.operationId,
      serviceId: value.serviceId, environmentName: value.environmentName, secretName: value.secretName, versionToken: value.versionToken,
      ...(value.secretArn === undefined ? {} : { secretArn: value.secretArn }) } as RuntimeSecretOwnershipEvent, { ...scope, operationId: row.pipelineRunId });
    if (row.metadata?.sha256 !== retained.metadata?.sha256) invalid();
    const identity = JSON.stringify([row.pipelineRunId, value.serviceId, value.secretName, value.versionToken]);
    if (value.phase === "intent") intents.add(identity);
    else { owned.add(identity); secrets.add(String(value.secretArn)); }
  }
  if ([...intents].some((intent) => !owned.has(intent)) || [...owned].some((receipt) => !intents.has(receipt))) invalid();
  return secrets;
}
