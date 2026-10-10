import { createHash } from "crypto";
import { isCanonicalEnvironmentName } from "./canonical-environment";

export const AWS_RESOURCE_OWNERSHIP_SOURCE = "aws_resource_ownership";
export const OWNERSHIP_FAMILIES = ["terraform", "ecr", "ecs", "runtime_secrets", "state"] as const;
export const AWS_RESOURCE_TYPES = ["aws_ecs_cluster", "aws_ecs_service", "aws_ecs_task", "aws_ecs_task_definition", "aws_security_group", "aws_lb", "aws_lb_listener", "aws_lb_target_group", "aws_efs_file_system", "aws_efs_access_point", "aws_efs_mount_target", "aws_secretsmanager_secret", "aws_iam_role", "aws_service_discovery_service", "aws_service_discovery_private_dns_namespace", "aws_cloudwatch_log_group", "aws_ecr_repository", "s3_state_object"] as const;
export type OwnedAwsResource = { type: typeof AWS_RESOURCE_TYPES[number]; id: string; parent?: string };
export type OwnershipScope = { projectId: string; operationId: string; environmentName: string; accountId: string; region: string };
export type DeletionManifest = { contractVersion: "deployguard.aws-deletion-manifest/v1"; scope: OwnershipScope & { generationIds: string[] }; resources: OwnedAwsResource[] };
export type AwsOwnershipJournal = { contractVersion: "deployguard.aws-resource-ownership/v1"; scope: OwnershipScope; sourceSha: string; coverage: string[]; unresolvedIntents: []; resources: OwnedAwsResource[] };
export type DestroyOwnership = { contractVersion: "deployguard.destroy-ownership/v1"; manifest: DeletionManifest; receipts: Array<{ operationId: string; sha256: string }> };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const object = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);
const keys = (v: Record<string, any>, allowed: string[]) => Object.keys(v).every((key) => allowed.includes(key));
const uuid = (v: unknown): v is string => typeof v === "string" && UUID.test(v);
const identifier = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 2048 && !/[\r\n\0*?]/.test(v) && !v.startsWith("-");
export class DestroyOwnershipIncompleteError extends Error {
  constructor() { super("DG_DESTROY_OWNERSHIP_INCOMPLETE: complete retained AWS ownership is required; historical ownership must be recovered before automatic deletion."); }
}
function fail(): never { throw new DestroyOwnershipIncompleteError(); }

/** JSONB may reorder nested keys. Only validated, identifier-only records enter this hash. */
export function ownershipSha256(value: unknown): string {
  const canonical = (v: any): any => Array.isArray(v) ? v.map(canonical) : object(v)
    ? Object.fromEntries(Object.keys(v).sort().map((key) => [key, canonical(v[key])])) : v;
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

export function assertOwnershipScope(value: unknown): asserts value is OwnershipScope & Record<string, any> {
  if (!object(value) || !uuid(value.projectId) || !uuid(value.operationId)
    || typeof value.environmentName !== "string" || !isCanonicalEnvironmentName(value.environmentName)
    || typeof value.accountId !== "string" || !/^\d{12}$/.test(value.accountId)
    || typeof value.region !== "string" || !/^[a-z]{2}(?:-[a-z]+)+-\d$/.test(value.region)
    || !keys(value, ["projectId", "operationId", "environmentName", "accountId", "region", "generationIds"])) fail();
}

export function assertOwnedAwsResources(value: unknown, scope: OwnershipScope): asserts value is OwnedAwsResource[] {
  if (!Array.isArray(value) || value.length > 1000) fail();
  const seen = new Set<string>();
  for (const resource of value) {
    if (!object(resource) || !keys(resource, ["type", "id", "parent"])
      || !AWS_RESOURCE_TYPES.includes(resource.type) || !identifier(resource.id)
      || (resource.parent !== undefined && !identifier(resource.parent))) fail();
    const identity = JSON.stringify([resource.type, resource.id]);
    if (seen.has(identity)) fail();
    seen.add(identity);
    for (const id of [resource.id, resource.parent].filter(Boolean)) {
      if (id.startsWith("arn:")) {
        const parts = id.split(":");
        if (parts[1] !== "aws" || parts[4] !== scope.accountId || (parts[3] && parts[3] !== scope.region)) fail();
      }
    }
    if (["aws_ecs_service", "aws_ecs_task"].includes(resource.type)) {
      const prefix = `arn:aws:ecs:${scope.region}:${scope.accountId}:`;
      if (!resource.parent?.startsWith(`${prefix}cluster/`) || !resource.id.startsWith(prefix)) fail();
      if (resource.type === "aws_ecs_task") {
        const task = resource.id.slice(prefix.length).match(/^task\/(?:([A-Za-z0-9_-]{1,255})\/)?[a-f0-9]{32}$/);
        if (!task || (task[1] && resource.parent !== `${prefix}cluster/${task[1]}`)) fail();
      }
    }
    if (resource.type === "s3_state_object") {
      const state = `projects/${scope.projectId}/${scope.environmentName}/runtime/terraform.tfstate`;
      if (![state, `${state}.tflock`].includes(resource.id) || !resource.parent || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(resource.parent)) fail();
    }
  }
}

export function assertDeletionManifest(value: unknown): asserts value is DeletionManifest {
  if (!object(value) || !keys(value, ["contractVersion", "scope", "resources"]) || value.contractVersion !== "deployguard.aws-deletion-manifest/v1") fail();
  assertOwnershipScope(value.scope);
  if (!Array.isArray(value.scope.generationIds) || !value.scope.generationIds.length || value.scope.generationIds.length > 1000
    || value.scope.generationIds.some((id: unknown) => !uuid(id)) || new Set(value.scope.generationIds).size !== value.scope.generationIds.length) fail();
  assertOwnedAwsResources(value.resources, value.scope);
  if (!value.resources.length) fail();
}

export function assertAwsOwnershipJournal(value: unknown): asserts value is AwsOwnershipJournal {
  if (!object(value) || !keys(value, ["contractVersion", "scope", "sourceSha", "coverage", "unresolvedIntents", "resources"])
    || value.contractVersion !== "deployguard.aws-resource-ownership/v1") fail();
  assertOwnershipScope(value.scope);
  if (!keys(value.scope, ["projectId", "operationId", "environmentName", "accountId", "region"])
    || typeof value.sourceSha !== "string" || !/^[a-f0-9]{40}$/i.test(value.sourceSha)
    || !Array.isArray(value.coverage) || value.coverage.length !== OWNERSHIP_FAMILIES.length
    || new Set(value.coverage).size !== OWNERSHIP_FAMILIES.length || OWNERSHIP_FAMILIES.some((family) => !value.coverage.includes(family))
    || !Array.isArray(value.unresolvedIntents) || value.unresolvedIntents.length) fail();
  assertOwnedAwsResources(value.resources, value.scope);
}

export function assertDestroyOwnership(value: unknown): asserts value is DestroyOwnership {
  if (!object(value) || !keys(value, ["contractVersion", "manifest", "receipts"]) || value.contractVersion !== "deployguard.destroy-ownership/v1") fail();
  assertDeletionManifest(value.manifest);
  if (!Array.isArray(value.receipts) || !value.receipts.length || value.receipts.length > 1000
    || value.receipts.some((r: unknown) => !object(r) || !keys(r, ["operationId", "sha256"]) || !uuid(r.operationId) || typeof r.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(r.sha256))
    || new Set(value.receipts.map((r: any) => r.operationId)).size !== value.receipts.length) fail();
  const state = `projects/${value.manifest.scope.projectId}/${value.manifest.scope.environmentName}/runtime/terraform.tfstate`;
  const states = value.manifest.resources.filter((r: OwnedAwsResource) => r.type === "s3_state_object");
  if (states.length !== 2 || !states.some((r: OwnedAwsResource) => r.id === state) || !states.some((r: OwnedAwsResource) => r.id === `${state}.tflock`) || states[0].parent !== states[1].parent) fail();
}

/** The server supplies the complete operation set; artifacts cannot choose a subset. */
export function freezeDestroyOwnership(scope: OwnershipScope & { generationIds: string[] }, operations: Array<{ id: string; projectId: string; commitSha: string | null; metadata: Record<string, unknown> | null }>, events: Array<{ pipelineRunId: string; projectId: string; source: string; metadata: Record<string, unknown> | null }>, stateBucket: string): DestroyOwnership {
  const receipts: DestroyOwnership["receipts"] = [];
  const resources = new Map<string, OwnedAwsResource>();
  if (!operations.length || operations.length > 1000 || new Set(operations.map((r) => r.id)).size !== operations.length) fail();
  for (const operation of operations) {
    if (operation.projectId !== scope.projectId || operation.metadata?.executionEngine !== "railpack") fail();
    const retained = events.filter((event) => event.source === AWS_RESOURCE_OWNERSHIP_SOURCE && event.pipelineRunId === operation.id);
    if (retained.length !== 1 || retained[0].projectId !== scope.projectId) fail();
    const journal = retained[0].metadata?.evidence;
    assertAwsOwnershipJournal(journal);
    if (journal.scope.operationId !== operation.id || journal.sourceSha !== operation.commitSha
      || ["projectId", "environmentName", "accountId", "region"].some((key) => journal.scope[key] !== scope[key])
      || retained[0].metadata?.sha256 !== ownershipSha256(journal)) fail();
    receipts.push({ operationId: operation.id, sha256: ownershipSha256(journal) });
    for (const resource of journal.resources) {
      const key = JSON.stringify([resource.type, resource.id]);
      const existing = resources.get(key);
      if (existing && existing.parent !== resource.parent) fail();
      resources.set(key, structuredClone(resource));
    }
  }
  const state = `projects/${scope.projectId}/${scope.environmentName}/runtime/terraform.tfstate`;
  for (const id of [state, `${state}.tflock`]) {
    const key = JSON.stringify(["s3_state_object", id]);
    if (resources.has(key) && resources.get(key)!.parent !== stateBucket) fail();
    resources.set(key, { type: "s3_state_object", id, parent: stateBucket });
  }
  const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
  const identity = (r: OwnedAwsResource) => JSON.stringify([r.type, r.parent || "", r.id]);
  const normalized = [...resources.values()].map((r) => ({ type: r.type, id: r.id, ...(r.parent === undefined ? {} : { parent: r.parent }) }));
  const result: DestroyOwnership = { contractVersion: "deployguard.destroy-ownership/v1", manifest: { contractVersion: "deployguard.aws-deletion-manifest/v1", scope: { ...structuredClone(scope), generationIds: [...scope.generationIds].sort() }, resources: normalized.sort((a, b) => compare(identity(a), identity(b))) }, receipts: receipts.sort((a, b) => compare(a.operationId, b.operationId)) };
  assertDestroyOwnership(result);
  return result;
}
