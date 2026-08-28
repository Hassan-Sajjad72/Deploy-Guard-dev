import { createHash } from "crypto";

/**
 * DeployGuard's only workflow contract.  It transports release identity and
 * runtime configuration; it deliberately contains no repository analysis.
 */
export const RAILPACK_WORKFLOW_CONTRACT_VERSION = "deployguard.railpack/v1";

export const RAILPACK_WORKFLOW_INPUTS = [
  { name: "deployment_action", required: true, type: "string" },
  { name: "deployment_operation_id", required: true, type: "string" },
  { name: "project_id", required: true, type: "string" },
  { name: "environment_name", required: true, type: "string" },
  { name: "repository_full_name", required: true, type: "string" },
  { name: "repository_branch", required: true, type: "string" },
  { name: "commit_sha", required: true, type: "string" },
  { name: "image_tag", required: true, type: "string" },
  { name: "environment_references_base64", required: true, type: "string" },
  { name: "managed_postgres_enabled", required: true, type: "string" },
  { name: "infrastructure_namespace", required: true, type: "string" },
  { name: "aws_region", required: true, type: "string" },
  { name: "aws_role_arn", required: true, type: "string" },
  { name: "vpc_id", required: true, type: "string" },
  { name: "public_subnet_ids", required: true, type: "string" },
  { name: "terraform_state_bucket", required: true, type: "string" },
  { name: "platform_port", required: true, type: "string" },
  { name: "rollback_image_digest", required: false, type: "string" },
  { name: "control_plane_sha", required: true, type: "string" },
] as const;

export type RailpackWorkflowInputName = typeof RAILPACK_WORKFLOW_INPUTS[number]["name"];
export type RailpackWorkflowInputs = Record<RailpackWorkflowInputName, string>;
export const RAILPACK_CALLER_INPUT_NAMES = RAILPACK_WORKFLOW_INPUTS.map(({ name }) => name);
export const RAILPACK_OPTIONAL_CALLER_INPUT_NAMES = ["rollback_image_digest"] as const;

export type RailpackRuntimeConfiguration = {
  schemaVersion: 1;
  projectId: string;
  environmentName: string;
  operationId: string;
  sourceSha: string;
  environment: Record<string, string>;
  secretReferences: Record<string, string>;
  managedPostgres: { enabled: boolean; engine: "postgres" | "mysql" | "mongodb" | null; aliases: string[] };
};

const SHA = /^[0-9a-f]{40}$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const KEY = /^[A-Z][A-Z0-9_]{0,127}$/;
const SECRET_VALUE_FROM = /^arn:(?:aws|aws-us-gov|aws-cn):secretsmanager:[a-z0-9-]+:\d{12}:secret:[A-Za-z0-9/_+=.@-]+(?::[A-Z][A-Z0-9_]{0,127}::)?$/;

export function immutableRailpackImageTag(commitSha: string, operationId: string) {
  if (!SHA.test(commitSha) || !UUID.test(operationId)) throw new Error("Railpack release identity is invalid.");
  return `sha-${commitSha.slice(0, 12).toLowerCase()}-${operationId.replace(/-/g, "").slice(0, 12)}`;
}

export function runtimeReferencesBase64(configuration: RailpackRuntimeConfiguration) {
  assertRailpackRuntimeConfiguration(configuration);
  return Buffer.from(JSON.stringify(configuration), "utf8").toString("base64");
}

export function immutableRailpackDispatchFingerprint(inputs: RailpackWorkflowInputs) {
  return createHash("sha256").update(JSON.stringify(Object.fromEntries(Object.entries(inputs).sort(([a], [b]) => a.localeCompare(b))))).digest("hex");
}

export function assertRailpackRuntimeConfiguration(value: RailpackRuntimeConfiguration) {
  if (value.schemaVersion !== 1 || !UUID.test(value.projectId) || !UUID.test(value.operationId) || !SHA.test(value.sourceSha)) {
    throw new Error("Railpack runtime configuration identity is invalid.");
  }
  for (const [key, item] of Object.entries(value.environment)) {
    if (!KEY.test(key) || typeof item !== "string") throw new Error("Railpack runtime environment is invalid.");
  }
  for (const [key, reference] of Object.entries(value.secretReferences)) {
    if (!KEY.test(key) || !SECRET_VALUE_FROM.test(reference)) throw new Error("Railpack runtime secret reference is invalid.");
  }
}
