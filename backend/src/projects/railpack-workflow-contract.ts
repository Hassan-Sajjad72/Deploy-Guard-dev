import { createHash } from "crypto";
import { normalizeServiceDirectory } from "./deployable-service-path";

export const RAILPACK_WORKFLOW_CONTRACT_VERSION = "deployguard.railpack/v4";
export const RAILPACK_RESULT_CONTRACT_VERSION = "deployguard.release-result/v5";
export const RAILPACK_WORKFLOW_INPUTS = [
  { name: "deployment_action", required: true, type: "string" }, { name: "deployment_operation_id", required: true, type: "string" },
  { name: "project_id", required: true, type: "string" }, { name: "environment_name", required: true, type: "string" },
  { name: "repository_full_name", required: true, type: "string" }, { name: "repository_branch", required: true, type: "string" },
  { name: "commit_sha", required: true, type: "string" }, { name: "services_base64", required: true, type: "string" },
  { name: "infrastructure_namespace", required: true, type: "string" }, { name: "aws_region", required: true, type: "string" },
  { name: "aws_role_arn", required: true, type: "string" }, { name: "vpc_id", required: true, type: "string" },
  { name: "public_subnet_ids", required: true, type: "string" }, { name: "terraform_state_bucket", required: true, type: "string" },
  { name: "control_plane_sha", required: true, type: "string" },
  { name: "result_contract_version", required: true, type: "string" },
] as const;
export type RailpackWorkflowInputName = typeof RAILPACK_WORKFLOW_INPUTS[number]["name"];
export type RailpackWorkflowInputs = Record<RailpackWorkflowInputName, string>;
export const RAILPACK_CALLER_INPUT_NAMES = RAILPACK_WORKFLOW_INPUTS.map(({ name }) => name);
export const RAILPACK_OPTIONAL_CALLER_INPUT_NAMES = [] as const;

export type RailpackServiceRuntimeConfiguration = { serviceId: string; serviceName: string; serviceDirectory: string; servicePort: number; runtimeConfigRevisionId: string; buildEnvironment: Record<string, string>; buildSecretReferences: Record<string, string>; environment: Record<string, string>; secretReferences: Record<string, string>; databaseAttached: boolean; managedDatabase: { engine: "postgres" | "mysql" | "mongodb" | null; aliases: string[]; secretVersionId?: string | null }; rollbackImage?: string };
export type RailpackRuntimeConfiguration = { schemaVersion: 3; projectId: string; environmentName: string; operationId: string; sourceSha: string; services: RailpackServiceRuntimeConfiguration[]; projectDeletion?: { generationIds: string[] } };

const SHA = /^[0-9a-f]{40}$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ENVIRONMENT_NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;
const KEY = /^[A-Z][A-Z0-9_]{0,127}$/;
const SECRET_VALUE_FROM = /^arn:(?:aws|aws-us-gov|aws-cn):secretsmanager:[a-z0-9-]+:\d{12}:secret:[A-Za-z0-9/_+=.@-]+:[A-Z][A-Z0-9_]{0,127}::[0-9a-f]{64}$/;
const SECRETS_MANAGER_VERSION_ID = /^[A-Za-z0-9-]{32,64}$/;
const IMMUTABLE_IMAGE = /^\d{12}\.dkr\.ecr\.[a-z0-9-]+\.amazonaws\.com\/[a-z0-9][a-z0-9._\/-]*@sha256:[0-9a-f]{64}$/i;

export function immutableRailpackServiceImageTag(commitSha: string, operationId: string, serviceId: string) {
  if (!SHA.test(commitSha) || !UUID.test(operationId) || !UUID.test(serviceId)) throw new Error("Railpack service release identity is invalid.");
  return `sha-${commitSha.slice(0, 10).toLowerCase()}-${operationId.replace(/-/g, "").slice(0, 8)}-${serviceId.replace(/-/g, "").slice(0, 8)}`;
}
export function servicesBase64(configuration: RailpackRuntimeConfiguration) { assertRailpackRuntimeConfiguration(configuration); return Buffer.from(JSON.stringify(configuration), "utf8").toString("base64"); }
export function immutableRailpackDispatchFingerprint(inputs: RailpackWorkflowInputs) { return createHash("sha256").update(JSON.stringify(Object.fromEntries(Object.entries(inputs).sort(([a], [b]) => a.localeCompare(b))))).digest("hex"); }

export function assertRailpackRuntimeConfiguration(value: RailpackRuntimeConfiguration) {
  if (value.schemaVersion !== 3 || !UUID.test(value.projectId) || !UUID.test(value.operationId) || !SHA.test(value.sourceSha) || !ENVIRONMENT_NAME.test(value.environmentName) || !Array.isArray(value.services) || !value.services.length || value.services.length > 20) throw new Error("Railpack runtime configuration identity is invalid.");
  const ids = new Set<string>(); const names = new Set<string>(); let databaseAttachments = 0;
  for (const service of value.services) {
    const loweredName = String(service.serviceName || "").trim().toLocaleLowerCase();
    if (!UUID.test(service.serviceId) || !UUID.test(service.runtimeConfigRevisionId) || !loweredName || service.serviceName !== service.serviceName.trim() || service.serviceName.length > 80 || ids.has(service.serviceId) || names.has(loweredName)) throw new Error("Railpack service identity is invalid.");
    ids.add(service.serviceId); names.add(loweredName);
    if (!Number.isInteger(service.servicePort) || service.servicePort < 1 || service.servicePort > 65535) throw new Error("Railpack service port is invalid.");
    if (normalizeServiceDirectory(service.serviceDirectory) !== service.serviceDirectory) throw new Error("Railpack service directory is not canonical.");
    if (!service.buildEnvironment || typeof service.buildEnvironment !== "object" || Array.isArray(service.buildEnvironment) || !service.buildSecretReferences || typeof service.buildSecretReferences !== "object" || Array.isArray(service.buildSecretReferences) || !service.environment || typeof service.environment !== "object" || Array.isArray(service.environment) || !service.secretReferences || typeof service.secretReferences !== "object" || Array.isArray(service.secretReferences)) throw new Error("Railpack build/runtime references are invalid.");
    for (const [key, item] of Object.entries(service.buildEnvironment)) if (!KEY.test(key) || typeof item !== "string" || ["PORT", "HOST"].includes(key) || (service.databaseAttached && service.managedDatabase.aliases.includes(key))) throw new Error("Railpack build environment is invalid.");
    for (const [key, reference] of Object.entries(service.buildSecretReferences)) if (!KEY.test(key) || !SECRET_VALUE_FROM.test(reference) || ["PORT", "HOST"].includes(key) || (service.databaseAttached && service.managedDatabase.aliases.includes(key))) throw new Error("Railpack build secret reference is invalid.");
    for (const [key, item] of Object.entries(service.environment)) if (!KEY.test(key) || typeof item !== "string" || (service.databaseAttached && service.managedDatabase.aliases.includes(key))) throw new Error("Railpack runtime environment is invalid.");
    if (service.environment.PORT !== String(service.servicePort) || service.environment.HOST !== "0.0.0.0") throw new Error("Railpack platform runtime values are invalid.");
    for (const [key, reference] of Object.entries(service.secretReferences)) if (!KEY.test(key) || !SECRET_VALUE_FROM.test(reference) || (service.databaseAttached && service.managedDatabase.aliases.includes(key))) throw new Error("Railpack runtime secret reference is invalid.");
    if (typeof service.databaseAttached !== "boolean" || !service.managedDatabase || !Array.isArray(service.managedDatabase.aliases) || !service.managedDatabase.aliases.every((alias) => KEY.test(alias)) || ![null, "postgres", "mysql", "mongodb"].includes(service.managedDatabase.engine)) throw new Error("Railpack managed database configuration is invalid.");
    if (service.managedDatabase.secretVersionId != null && !SECRETS_MANAGER_VERSION_ID.test(service.managedDatabase.secretVersionId)) throw new Error("Railpack managed database secret-version identity is invalid.");
    if (service.databaseAttached) databaseAttachments += 1;
    if (service.databaseAttached && (!service.managedDatabase.engine || !service.managedDatabase.aliases.length)) throw new Error("Attached managed database configuration is incomplete.");
    if (!service.databaseAttached && (service.managedDatabase.engine !== null || service.managedDatabase.aliases.length)) throw new Error("Database configuration may only be present on its attached service.");
    if (service.rollbackImage && !IMMUTABLE_IMAGE.test(service.rollbackImage)) throw new Error("Railpack rollback service image is invalid.");
  }
  if (databaseAttachments > 1) throw new Error("Managed database may be attached to only one service.");
  if (value.projectDeletion && (!Array.isArray(value.projectDeletion.generationIds) || !value.projectDeletion.generationIds.length || value.projectDeletion.generationIds.some((id) => !UUID.test(id)) || new Set(value.projectDeletion.generationIds).size !== value.projectDeletion.generationIds.length)) throw new Error("Railpack destroy generation identity is invalid.");
}
