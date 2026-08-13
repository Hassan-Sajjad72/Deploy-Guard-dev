import { canonicalSha256 } from "./canonical-json";
import {
  CreateInfrastructureManifestInputV1,
  INFRASTRUCTURE_MANIFEST_ORIGINS,
  InfrastructureChangeSetV1,
  InfrastructureSpecV1,
} from "./infrastructure-manifest.types";
import {
  CreateReleaseManifestInputV1,
  RELEASE_MANIFEST_ORIGINS,
  ReleaseSpecV1,
} from "./release-manifest.types";
import { TWO_LANE_CONTRACT_SCHEMA_VERSION } from "./version";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;
const COMMIT_SHA = /^[0-9a-f]{40,64}$/i;
const ENVIRONMENT = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const AWS_REGION = /^[a-z]{2}(?:-gov)?-[a-z]+-\d$/;
const FORBIDDEN_MATERIAL_KEY = /(password|credential|private[_-]?key|access[_-]?key|secret|token)/i;
const SAFE_REFERENCE_KEY =
  /(reference|references|referenceNames|hash|configured|required|fencingTokenRequired)$/i;
const SECRET_VALUE_PATTERN = /-----BEGIN [A-Z ]*PRIVATE KEY-----|\bAKIA[0-9A-Z]{16}\b|\bgh[opsu]_[A-Za-z0-9_]{20,}\b/;

function object(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error(`${path} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(record: Record<string, unknown>, allowed: readonly string[], required: readonly string[], path: string) {
  const extras = Object.keys(record).filter((key) => !allowed.includes(key));
  if (extras.length) throw new Error(`${path} contains mutable or unknown fields: ${extras.join(", ")}.`);
  const missing = required.filter((key) => !(key in record));
  if (missing.length) throw new Error(`${path} is missing required fields: ${missing.join(", ")}.`);
}

function string(value: unknown, path: string, options: { min?: number; max?: number; pattern?: RegExp } = {}) {
  if (typeof value !== "string") throw new Error(`${path} must be a string.`);
  if (value.length < (options.min ?? 1) || value.length > (options.max ?? 4096)) {
    throw new Error(`${path} has an invalid length.`);
  }
  if (options.pattern && !options.pattern.test(value)) throw new Error(`${path} has an invalid format.`);
  if (SECRET_VALUE_PATTERN.test(value)) throw new Error(`${path} contains secret material.`);
  return value;
}

function nullableString(value: unknown, path: string) {
  if (value === null) return null;
  return string(value, path);
}

function boolean(value: unknown, path: string) {
  if (typeof value !== "boolean") throw new Error(`${path} must be a boolean.`);
  return value;
}

function integer(value: unknown, path: string, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new Error(`${path} must be an integer between ${minimum} and ${maximum}.`);
  }
  return Number(value);
}

function oneOf<T extends string>(value: unknown, values: readonly T[], path: string): T {
  if (typeof value !== "string" || !values.includes(value as T)) {
    throw new Error(`${path} must be one of: ${values.join(", ")}.`);
  }
  return value as T;
}

function stringArray(value: unknown, path: string, unique = true) {
  if (!Array.isArray(value)) throw new Error(`${path} must be an array.`);
  const items = value.map((item, index) => string(item, `${path}[${index}]`, { max: 512 }));
  if (unique && new Set(items).size !== items.length) throw new Error(`${path} cannot contain duplicates.`);
  return items;
}

function optionalUuid(value: unknown, path: string) {
  if (value === undefined || value === null) return null;
  return string(value, path, { pattern: UUID });
}

function assertNoSecretMaterial(value: unknown, path = "$") {
  if (typeof value === "string") {
    if (SECRET_VALUE_PATTERN.test(value)) throw new Error(`${path} contains secret material.`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoSecretMaterial(item, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_MATERIAL_KEY.test(key) && !SAFE_REFERENCE_KEY.test(key)) {
      throw new Error(`${path}.${key} is not a permitted secret reference field.`);
    }
    assertNoSecretMaterial(item, `${path}.${key}`);
  }
}

function validateInfrastructureSpec(value: unknown): InfrastructureSpecV1 {
  const spec = object(value, "desiredSpec");
  exactKeys(spec, [
    "region", "terraformTemplateVersion", "network", "registry", "ecsFoundation",
    "ingress", "database", "storage", "discovery", "observability", "iamPolicyRevision", "tags",
  ], [
    "region", "terraformTemplateVersion", "network", "registry", "ecsFoundation",
    "ingress", "database", "storage", "discovery", "observability", "iamPolicyRevision", "tags",
  ], "desiredSpec");
  string(spec.region, "desiredSpec.region", { pattern: AWS_REGION });
  string(spec.terraformTemplateVersion, "desiredSpec.terraformTemplateVersion", { max: 128 });

  const network = object(spec.network, "desiredSpec.network");
  exactKeys(network, ["topology", "availabilityZoneCount", "publicSubnets", "privateSubnets", "natMode"], ["topology", "availabilityZoneCount", "publicSubnets", "privateSubnets", "natMode"], "desiredSpec.network");
  oneOf(network.topology, ["managed_vpc"], "desiredSpec.network.topology");
  integer(network.availabilityZoneCount, "desiredSpec.network.availabilityZoneCount", 1, 6);
  boolean(network.publicSubnets, "desiredSpec.network.publicSubnets");
  boolean(network.privateSubnets, "desiredSpec.network.privateSubnets");
  oneOf(network.natMode, ["none", "single", "per_az"], "desiredSpec.network.natMode");

  const registry = object(spec.registry, "desiredSpec.registry");
  exactKeys(registry, ["managedEcrRepository", "immutableTags", "lifecyclePolicyHash"], ["managedEcrRepository", "immutableTags", "lifecyclePolicyHash"], "desiredSpec.registry");
  boolean(registry.managedEcrRepository, "desiredSpec.registry.managedEcrRepository");
  boolean(registry.immutableTags, "desiredSpec.registry.immutableTags");
  if (registry.lifecyclePolicyHash !== null) string(registry.lifecyclePolicyHash, "desiredSpec.registry.lifecyclePolicyHash", { pattern: SHA256 });

  const ecs = object(spec.ecsFoundation, "desiredSpec.ecsFoundation");
  exactKeys(ecs, ["clusterMode", "serviceName", "launchType", "capacityProviders"], ["clusterMode", "serviceName", "launchType", "capacityProviders"], "desiredSpec.ecsFoundation");
  oneOf(ecs.clusterMode, ["shared_project", "dedicated_project"], "desiredSpec.ecsFoundation.clusterMode");
  string(ecs.serviceName, "desiredSpec.ecsFoundation.serviceName", { max: 255 });
  oneOf(ecs.launchType, ["fargate"], "desiredSpec.ecsFoundation.launchType");
  stringArray(ecs.capacityProviders, "desiredSpec.ecsFoundation.capacityProviders");

  const ingress = object(spec.ingress, "desiredSpec.ingress");
  exactKeys(ingress, ["enabled", "protocol", "containerPort", "targetGroupPort", "healthCheckPath", "healthCheckProtocol"], ["enabled", "protocol", "containerPort", "targetGroupPort", "healthCheckPath", "healthCheckProtocol"], "desiredSpec.ingress");
  boolean(ingress.enabled, "desiredSpec.ingress.enabled");
  oneOf(ingress.protocol, ["HTTP", "HTTPS"], "desiredSpec.ingress.protocol");
  integer(ingress.containerPort, "desiredSpec.ingress.containerPort", 1, 65535);
  integer(ingress.targetGroupPort, "desiredSpec.ingress.targetGroupPort", 1, 65535);
  string(ingress.healthCheckPath, "desiredSpec.ingress.healthCheckPath", { max: 1024, pattern: /^\// });
  oneOf(ingress.healthCheckProtocol, ["HTTP"], "desiredSpec.ingress.healthCheckProtocol");

  const database = object(spec.database, "desiredSpec.database");
  exactKeys(database, ["mode", "engine", "tierRevision", "persistence", "externalTlsRequired"], ["mode", "engine", "tierRevision", "persistence", "externalTlsRequired"], "desiredSpec.database");
  oneOf(database.mode, ["none", "managed", "external"], "desiredSpec.database.mode");
  if (database.engine !== null) oneOf(database.engine, ["postgres", "mysql"], "desiredSpec.database.engine");
  if (database.tierRevision !== null) string(database.tierRevision, "desiredSpec.database.tierRevision", { max: 255 });
  boolean(database.persistence, "desiredSpec.database.persistence");
  if (database.externalTlsRequired !== null) boolean(database.externalTlsRequired, "desiredSpec.database.externalTlsRequired");

  for (const [key, fields] of Object.entries({
    storage: ["efsRequired", "accessPointRequired", "encrypted", "backupRequired"],
    observability: ["cloudWatchLogs", "cloudWatchMetrics", "prometheus"],
  })) {
    const record = object(spec[key], `desiredSpec.${key}`);
    exactKeys(record, fields, fields, `desiredSpec.${key}`);
    fields.forEach((field) => boolean(record[field], `desiredSpec.${key}.${field}`));
  }

  const discovery = object(spec.discovery, "desiredSpec.discovery");
  exactKeys(discovery, ["cloudMapRequired", "namespace"], ["cloudMapRequired", "namespace"], "desiredSpec.discovery");
  boolean(discovery.cloudMapRequired, "desiredSpec.discovery.cloudMapRequired");
  if (discovery.namespace !== null) string(discovery.namespace, "desiredSpec.discovery.namespace", { max: 255 });

  string(spec.iamPolicyRevision, "desiredSpec.iamPolicyRevision", { max: 255 });
  const tags = object(spec.tags, "desiredSpec.tags");
  for (const [key, tagValue] of Object.entries(tags)) {
    if (FORBIDDEN_MATERIAL_KEY.test(key)) throw new Error(`desiredSpec.tags.${key} is secret-like and is not permitted.`);
    string(tagValue, `desiredSpec.tags.${key}`, { max: 256 });
  }
  assertNoSecretMaterial(spec, "desiredSpec");
  return spec as InfrastructureSpecV1;
}

function validateChangeSet(value: unknown): InfrastructureChangeSetV1 {
  const changeSet = object(value, "changeSet");
  exactKeys(changeSet, ["fromManifestId", "changedPaths", "categories", "destructivePaths", "requiresApproval", "reasonCodes"], ["fromManifestId", "changedPaths", "categories", "destructivePaths", "requiresApproval", "reasonCodes"], "changeSet");
  optionalUuid(changeSet.fromManifestId, "changeSet.fromManifestId");
  stringArray(changeSet.changedPaths, "changeSet.changedPaths");
  if (!Array.isArray(changeSet.categories)) throw new Error("changeSet.categories must be an array.");
  changeSet.categories.forEach((item, index) => oneOf(item, ["network", "registry", "ecs_foundation", "ingress", "database", "storage", "discovery", "observability", "iam", "tags"], `changeSet.categories[${index}]`));
  stringArray(changeSet.destructivePaths, "changeSet.destructivePaths");
  boolean(changeSet.requiresApproval, "changeSet.requiresApproval");
  stringArray(changeSet.reasonCodes, "changeSet.reasonCodes");
  return changeSet as InfrastructureChangeSetV1;
}

function validateReleaseSpec(value: unknown): ReleaseSpecV1 {
  const spec = object(value, "releaseSpec");
  exactKeys(spec, ["source", "build", "runtime", "health"], ["source", "build", "runtime", "health"], "releaseSpec");
  const source = object(spec.source, "releaseSpec.source");
  exactKeys(source, ["repositoryFullName", "branch", "commitSha", "appRoot"], ["repositoryFullName", "branch", "commitSha", "appRoot"], "releaseSpec.source");
  string(source.repositoryFullName, "releaseSpec.source.repositoryFullName", { max: 512 });
  string(source.branch, "releaseSpec.source.branch", { max: 255 });
  string(source.commitSha, "releaseSpec.source.commitSha", { pattern: COMMIT_SHA });
  string(source.appRoot, "releaseSpec.source.appRoot", { max: 1024 });

  const build = object(spec.build, "releaseSpec.build");
  exactKeys(build, ["dockerStrategy", "dockerTemplate", "buildCommand", "outputDirectory", "buildArgumentNames"], ["dockerStrategy", "dockerTemplate", "buildCommand", "outputDirectory", "buildArgumentNames"], "releaseSpec.build");
  oneOf(build.dockerStrategy, ["generated", "custom"], "releaseSpec.build.dockerStrategy");
  if (build.dockerTemplate !== null) nullableString(build.dockerTemplate, "releaseSpec.build.dockerTemplate");
  if (build.buildCommand !== null) nullableString(build.buildCommand, "releaseSpec.build.buildCommand");
  if (build.outputDirectory !== null) nullableString(build.outputDirectory, "releaseSpec.build.outputDirectory");
  stringArray(build.buildArgumentNames, "releaseSpec.build.buildArgumentNames");

  const runtime = object(spec.runtime, "releaseSpec.runtime");
  exactKeys(runtime, ["imageUri", "imageDigest", "command", "containerPort", "cpu", "memory", "plainVariableNames", "secretReferenceNames", "serviceBindingRevisions"], ["imageUri", "imageDigest", "command", "containerPort", "cpu", "memory", "plainVariableNames", "secretReferenceNames", "serviceBindingRevisions"], "releaseSpec.runtime");
  if (runtime.imageUri !== null) nullableString(runtime.imageUri, "releaseSpec.runtime.imageUri");
  if (runtime.imageDigest !== null) nullableString(runtime.imageDigest, "releaseSpec.runtime.imageDigest");
  if (runtime.command !== null) nullableString(runtime.command, "releaseSpec.runtime.command");
  integer(runtime.containerPort, "releaseSpec.runtime.containerPort", 1, 65535);
  integer(runtime.cpu, "releaseSpec.runtime.cpu", 1, 16384);
  integer(runtime.memory, "releaseSpec.runtime.memory", 1, 131072);
  stringArray(runtime.plainVariableNames, "releaseSpec.runtime.plainVariableNames");
  stringArray(runtime.secretReferenceNames, "releaseSpec.runtime.secretReferenceNames");
  if (!Array.isArray(runtime.serviceBindingRevisions)) throw new Error("releaseSpec.runtime.serviceBindingRevisions must be an array.");
  runtime.serviceBindingRevisions.forEach((item, index) => {
    const binding = object(item, `releaseSpec.runtime.serviceBindingRevisions[${index}]`);
    exactKeys(binding, ["id", "revision"], ["id", "revision"], `releaseSpec.runtime.serviceBindingRevisions[${index}]`);
    string(binding.id, `releaseSpec.runtime.serviceBindingRevisions[${index}].id`, { pattern: UUID });
    string(binding.revision, `releaseSpec.runtime.serviceBindingRevisions[${index}].revision`, { max: 255 });
  });

  const health = object(spec.health, "releaseSpec.health");
  exactKeys(health, ["path", "expectedPort", "gracePeriodSeconds"], ["path", "expectedPort", "gracePeriodSeconds"], "releaseSpec.health");
  string(health.path, "releaseSpec.health.path", { max: 1024, pattern: /^\// });
  integer(health.expectedPort, "releaseSpec.health.expectedPort", 1, 65535);
  integer(health.gracePeriodSeconds, "releaseSpec.health.gracePeriodSeconds", 0, 3600);
  assertNoSecretMaterial(spec, "releaseSpec");
  return spec as ReleaseSpecV1;
}

export function validateInfrastructureManifestCreate(value: unknown): CreateInfrastructureManifestInputV1 {
  const input = object(value, "infrastructureManifest");
  const allowed = ["schemaVersion", "projectId", "environmentName", "parentManifestId", "createdByUserId", "origin", "terraformTemplateVersion", "stateBackend", "stateKey", "desiredSpec", "changeSet", "requiresTerraform", "specHash"];
  exactKeys(input, allowed, ["schemaVersion", "projectId", "environmentName", "origin", "terraformTemplateVersion", "stateBackend", "stateKey", "desiredSpec", "changeSet", "requiresTerraform", "specHash"], "infrastructureManifest");
  if (input.schemaVersion !== TWO_LANE_CONTRACT_SCHEMA_VERSION) throw new Error("Unsupported infrastructure manifest schema version.");
  string(input.projectId, "infrastructureManifest.projectId", { pattern: UUID });
  string(input.environmentName, "infrastructureManifest.environmentName", { pattern: ENVIRONMENT });
  optionalUuid(input.parentManifestId, "infrastructureManifest.parentManifestId");
  if (input.createdByUserId !== undefined && input.createdByUserId !== null) integer(input.createdByUserId, "infrastructureManifest.createdByUserId", 1);
  oneOf(input.origin, INFRASTRUCTURE_MANIFEST_ORIGINS, "infrastructureManifest.origin");
  string(input.terraformTemplateVersion, "infrastructureManifest.terraformTemplateVersion", { max: 128 });
  oneOf(input.stateBackend, ["s3", "local_mock"], "infrastructureManifest.stateBackend");
  string(input.stateKey, "infrastructureManifest.stateKey", { max: 512 });
  const spec = validateInfrastructureSpec(input.desiredSpec);
  validateChangeSet(input.changeSet);
  boolean(input.requiresTerraform, "infrastructureManifest.requiresTerraform");
  string(input.specHash, "infrastructureManifest.specHash", { pattern: SHA256 });
  if (input.specHash !== canonicalSha256(spec)) throw new Error("Infrastructure manifest specHash does not match desiredSpec.");
  assertNoSecretMaterial(input, "infrastructureManifest");
  return input as unknown as CreateInfrastructureManifestInputV1;
}

export function validateReleaseManifestCreate(value: unknown): CreateReleaseManifestInputV1 {
  const input = object(value, "releaseManifest");
  const allowed = ["schemaVersion", "projectId", "environmentName", "infrastructureManifestId", "parentManifestId", "previousStableManifestId", "deploymentContractId", "configurationSnapshotId", "origin", "repositoryFullName", "branch", "commitSha", "appRoot", "deploymentContractHash", "configurationFingerprint", "buildFingerprint", "runtimeFingerprint", "releaseSpec", "specHash"];
  exactKeys(input, allowed, ["schemaVersion", "projectId", "environmentName", "infrastructureManifestId", "origin", "repositoryFullName", "branch", "commitSha", "appRoot", "deploymentContractHash", "configurationFingerprint", "buildFingerprint", "runtimeFingerprint", "releaseSpec", "specHash"], "releaseManifest");
  if (input.schemaVersion !== TWO_LANE_CONTRACT_SCHEMA_VERSION) throw new Error("Unsupported release manifest schema version.");
  string(input.projectId, "releaseManifest.projectId", { pattern: UUID });
  string(input.environmentName, "releaseManifest.environmentName", { pattern: ENVIRONMENT });
  string(input.infrastructureManifestId, "releaseManifest.infrastructureManifestId", { pattern: UUID });
  optionalUuid(input.parentManifestId, "releaseManifest.parentManifestId");
  optionalUuid(input.previousStableManifestId, "releaseManifest.previousStableManifestId");
  optionalUuid(input.deploymentContractId, "releaseManifest.deploymentContractId");
  optionalUuid(input.configurationSnapshotId, "releaseManifest.configurationSnapshotId");
  oneOf(input.origin, RELEASE_MANIFEST_ORIGINS, "releaseManifest.origin");
  string(input.repositoryFullName, "releaseManifest.repositoryFullName", { max: 512 });
  string(input.branch, "releaseManifest.branch", { max: 255 });
  string(input.commitSha, "releaseManifest.commitSha", { pattern: COMMIT_SHA });
  string(input.appRoot, "releaseManifest.appRoot", { max: 1024 });
  for (const key of ["deploymentContractHash", "configurationFingerprint", "buildFingerprint", "runtimeFingerprint", "specHash"]) {
    string(input[key], `releaseManifest.${key}`, { pattern: SHA256 });
  }
  const spec = validateReleaseSpec(input.releaseSpec);
  if (input.specHash !== canonicalSha256(spec)) throw new Error("Release manifest specHash does not match releaseSpec.");
  if (spec.source.commitSha !== input.commitSha || spec.source.repositoryFullName !== input.repositoryFullName || spec.source.branch !== input.branch || spec.source.appRoot !== input.appRoot) {
    throw new Error("Release manifest source fields do not match releaseSpec.source.");
  }
  assertNoSecretMaterial(input, "releaseManifest");
  return input as unknown as CreateReleaseManifestInputV1;
}

export { assertNoSecretMaterial };
