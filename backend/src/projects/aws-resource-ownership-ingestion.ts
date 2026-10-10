import { DataSource } from "typeorm";
import { AWS_RESOURCE_OWNERSHIP_SOURCE, assertAwsOwnershipJournal, assertOwnershipScope, AwsOwnershipJournal, DestroyOwnershipIncompleteError, OWNERSHIP_FAMILIES, ownershipSha256, OwnershipScope } from "./aws-resource-ownership";
import { acquireProjectConfigurationAdvisoryLock } from "./project-configuration-lock";
import { ProjectPipelineEvent } from "./project-pipeline-event.entity";
import { ProjectPipelineRun } from "./project-pipeline-run.entity";
import { assertRailpackRuntimeConfiguration, immutableRailpackDispatchFingerprint, RAILPACK_WORKFLOW_INPUTS, RailpackRuntimeConfiguration, RailpackWorkflowInputs } from "./railpack-workflow-contract";
import { restoreRuntimeSecretOwnership, RUNTIME_SECRET_OWNERSHIP_SOURCE, RuntimeSecretOwnershipPersistenceError } from "./runtime-secret-ownership";

export const AWS_RESOURCE_COLLECTION_CONTRACT = "deployguard.aws-resource-collection/v1";
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
function incomplete(): never { throw new DestroyOwnershipIncompleteError(); }

/** Never recover artifact identity from mutable project configuration. */
export function awsOwnershipCollectionContext(operation: ProjectPipelineRun) {
  const inputs = operation.metadata?.immutableDispatchInputs;
  if (!object(inputs) || Object.keys(inputs).length !== RAILPACK_WORKFLOW_INPUTS.length
    || RAILPACK_WORKFLOW_INPUTS.some(({ name }) => typeof inputs[name] !== "string")
    || RAILPACK_WORKFLOW_INPUTS.some(({ name }) => String(inputs[name]).length > 65535)
    || operation.metadata?.executionEngine !== "railpack" || !["deploy", "rollback"].includes(String(operation.metadata?.deploymentAction))
    || inputs.deployment_action !== operation.metadata?.deploymentAction || inputs.deployment_operation_id !== operation.id
    || inputs.project_id !== operation.projectId || inputs.commit_sha !== operation.commitSha
    || inputs.repository_full_name !== operation.repositoryFullName || inputs.repository_branch !== operation.targetBranch
    || !/^[1-9][0-9]{0,19}$/.test(operation.githubWorkflowRunId || "")
    || !/^[a-f0-9]{40}$/i.test(String(inputs.control_plane_sha))
    || operation.metadata?.configuredControlPlaneSha !== inputs.control_plane_sha
    || operation.metadata?.immutableDispatchFingerprint !== immutableRailpackDispatchFingerprint(inputs as RailpackWorkflowInputs)) incomplete();
  const role = String(inputs.aws_role_arn).match(/^arn:aws:iam::(\d{12}):role\/[A-Za-z0-9/+=,.@_-]+$/);
  if (!role || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(String(inputs.terraform_state_bucket))) incomplete();
  const scope: OwnershipScope = { projectId: operation.projectId, operationId: operation.id, environmentName: String(inputs.environment_name), accountId: role[1], region: String(inputs.aws_region) };
  assertOwnershipScope(scope);
  let runtime: RailpackRuntimeConfiguration;
  try {
    const bytes = Buffer.from(String(inputs.services_base64), "base64");
    if (bytes.toString("base64") !== inputs.services_base64) incomplete();
    runtime = JSON.parse(bytes.toString("utf8")) as RailpackRuntimeConfiguration;
    assertRailpackRuntimeConfiguration(runtime);
    if (runtime.projectId !== scope.projectId || runtime.operationId !== scope.operationId || runtime.environmentName !== scope.environmentName || runtime.sourceSha !== operation.commitSha) incomplete();
  } catch { incomplete(); }
  const runtimeSecretArns = [...new Set(runtime.services.flatMap((service) => [...Object.values(service.buildSecretReferences), ...Object.values(service.secretReferences)])
    .map((reference) => reference.split(":").slice(0, 7).join(":")))].sort();
  return { scope, stateBucket: String(inputs.terraform_state_bucket), workflowRunId: operation.githubWorkflowRunId,
    controlPlaneSha: String(inputs.control_plane_sha), dispatchFingerprint: String(operation.metadata.immutableDispatchFingerprint), runtimeSecretArns };
}

/** The runner covers four families. Only the server can certify its secret
 * writes from retained intent/owned pairs. No caller-controlled secret payload
 * or completeness declaration substitutes for those rows.
 */
export function buildAwsOwnershipJournal(collection: unknown, operation: ProjectPipelineRun,
  runtimeEvents: Array<Pick<ProjectPipelineEvent, "pipelineRunId" | "projectId" | "source" | "metadata">>): AwsOwnershipJournal {
  const context = awsOwnershipCollectionContext(operation);
  if (!object(collection) || collection.contractVersion !== AWS_RESOURCE_COLLECTION_CONTRACT || !Array.isArray(collection.coverage)) incomplete();
  const candidate = { ...collection, contractVersion: "deployguard.aws-resource-ownership/v1", coverage: [...collection.coverage, "runtime_secrets"] };
  assertAwsOwnershipJournal(candidate);
  if (candidate.sourceSha !== operation.commitSha || Object.keys(context.scope).some((key) => candidate.scope[key] !== context.scope[key])) incomplete();
  const state = `projects/${context.scope.projectId}/${context.scope.environmentName}/runtime/terraform.tfstate`;
  const states = candidate.resources.filter((resource) => resource.type === "s3_state_object");
  if (states.length !== 2 || ![state, `${state}.tflock`].every((id) => states.some((resource) => resource.id === id && resource.parent === context.stateBucket))) incomplete();
  let secrets: Set<string>;
  try { secrets = restoreRuntimeSecretOwnership(runtimeEvents, context.scope); }
  catch (error) { if (error instanceof RuntimeSecretOwnershipPersistenceError) incomplete(); throw error; }
  if (operation.metadata.deploymentAction === "deploy" && context.runtimeSecretArns.some((arn) => !secrets.has(arn))) incomplete();
  const resources = new Map(candidate.resources.map((resource) => [JSON.stringify([resource.type, resource.id]), resource]));
  for (const arn of secrets) {
    const key = JSON.stringify(["aws_secretsmanager_secret", arn]);
    if (resources.get(key)?.parent !== undefined) incomplete();
    resources.set(key, { type: "aws_secretsmanager_secret", id: arn });
  }
  const identity = (resource: AwsOwnershipJournal["resources"][number]) => JSON.stringify([resource.type, resource.parent || "", resource.id]);
  const journal: AwsOwnershipJournal = { contractVersion: "deployguard.aws-resource-ownership/v1", scope: context.scope,
    sourceSha: operation.commitSha, coverage: [...OWNERSHIP_FAMILIES], unresolvedIntents: [],
    resources: [...resources.values()].map((resource) => ({ type: resource.type, id: resource.id, ...(resource.parent === undefined ? {} : { parent: resource.parent }) }))
      .sort((a, b) => identity(a) < identity(b) ? -1 : identity(a) > identity(b) ? 1 : 0) };
  assertAwsOwnershipJournal(journal);
  return journal;
}

/** Append-only and idempotent under the existing configuration/operation locks.
 * Contradictory receipts are retained, not overwritten or silently unioned: the
 * complete-history reader rejects their ambiguity until ownership is recovered.
 */
export async function retainAwsOwnershipCollection(dataSource: DataSource, operation: ProjectPipelineRun, collection: unknown): Promise<"retained" | "conflict"> {
  const context = awsOwnershipCollectionContext(operation);
  return dataSource.transaction(async (manager) => {
    await acquireProjectConfigurationAdvisoryLock(manager, operation.projectId, context.scope.environmentName);
    const current = await manager.getRepository(ProjectPipelineRun).findOne({ where: { id: operation.id, projectId: operation.projectId }, lock: { mode: "pessimistic_write" } });
    if (!current || ownershipSha256(awsOwnershipCollectionContext(current)) !== ownershipSha256(context)) incomplete();
    const events = manager.getRepository(ProjectPipelineEvent);
    const runtimeEvents = await events.find({ where: { projectId: operation.projectId, pipelineRunId: operation.id, source: RUNTIME_SECRET_OWNERSHIP_SOURCE }, take: 1001 });
    const journal = buildAwsOwnershipJournal(collection, current, runtimeEvents);
    const sha256 = ownershipSha256(journal);
    const retained = await events.find({ where: { projectId: operation.projectId, pipelineRunId: operation.id, source: AWS_RESOURCE_OWNERSHIP_SOURCE }, take: 2 });
    if (retained.length > 1) return "conflict";
    if (retained.length === 1 && retained[0].metadata?.sha256 === sha256 && ownershipSha256(retained[0].metadata?.evidence) === sha256) return "retained";
    await events.save({ projectId: operation.projectId, pipelineRunId: operation.id, stage: "ownership_retention", status: "completed",
      message: "Immutable AWS ownership identifiers retained.", source: AWS_RESOURCE_OWNERSHIP_SOURCE,
      metadata: { evidence: journal, sha256, transport: { workflowRunId: context.workflowRunId, controlPlaneSha: context.controlPlaneSha, dispatchFingerprint: context.dispatchFingerprint } } });
    return retained.length ? "conflict" : "retained";
  });
}
