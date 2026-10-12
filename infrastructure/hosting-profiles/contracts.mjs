import { createHash } from 'node:crypto';

export const CONTRACT_VERSION = 'deployguard.hosting-artifacts/v1';
export const AWS_PROVIDER_VERSION = '5.100.0';
export const PROFILES = ['ec2', 'lightsail', 'static', 'lambda'];
export function fingerprint(value) {
  const canonical = (v) => Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object'
    ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical(v[k])])) : v;
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}
export function requireValue(condition, message) { if (!condition) throw new Error(message); }
export function exactKeys(value, keys, name) {
  requireValue(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every((key) => keys.includes(key)), `Unsupported fields in ${name}.`);
}
export function text(value, pattern, name) {
  requireValue(typeof value === 'string' && pattern.test(value), `Invalid ${name}.`); return value;
}
export const sha = (value, name = 'SHA-256') => text(value, /^[a-f0-9]{64}$/, name);
export const uuid = (value, name) => text(value, /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i, name);
export const literal = (value) => String(value).replaceAll('${', '$${').replaceAll('%{', '%%{');
export const json = (value) => literal(JSON.stringify(value));
export const reference = (value) => '${' + value + '}';
export function boundedNumber(value, min, max, name, integer = false) {
  requireValue(typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max && (!integer || Number.isInteger(value)), `Invalid ${name}.`); return value;
}
export function environmentReferences(values = {}) {
  requireValue(values && typeof values === 'object' && !Array.isArray(values) && Object.keys(values).length <= 100, 'Invalid public environment references.');
  for (const [key, value] of Object.entries(values)) {
    text(key, /^[A-Za-z_][A-Za-z0-9_]{0,127}$/, 'environment key');
    requireValue(!/^(AWS_|DEPLOYGUARD_|DG_)/i.test(key), 'Reserved environment key.');
    // Plain values, including accidentally supplied credentials, never belong in artifacts.
    requireValue(value && typeof value === 'object' && Object.keys(value).length === 1 && typeof value.publicValue === 'string' && value.publicValue.length <= 2048 && !/[\r\n\0]/.test(value.publicValue), 'Public values must use an explicit publicValue declaration.');
    requireValue(!/(SECRET|PASSWORD|TOKEN|PRIVATE_KEY|ACCESS_KEY|DATABASE_URL|DB_URL|AUTHORIZATION)/i.test(key), 'Sensitive configuration requires a versioned secret reference.');
  }
  return Object.fromEntries(Object.entries(values).map(([key, value]) => [key, value.publicValue]));
}
export function secretReferences(values = [], scope) {
  requireValue(Array.isArray(values) && values.length <= 50, 'Invalid secret references.');
  const keys = new Set();
  for (const value of values) {
    text(value.key, /^[A-Za-z_][A-Za-z0-9_]{0,127}$/, 'secret environment key');
    requireValue(!/^(AWS_|DEPLOYGUARD_|DG_)/i.test(value.key) && !keys.has(value.key), 'Duplicate or reserved secret key.'); keys.add(value.key);
    text(value.arn, new RegExp(`^arn:aws:secretsmanager:${scope.region}:${scope.accountId}:secret:dg-${scope.projectId.replaceAll('-', '').slice(0, 12)}-[A-Za-z0-9_/-]{1,200}-[A-Za-z0-9]{6}$`), 'project secret ARN');
    text(value.versionId, /^[A-Za-z0-9-]{32,64}$/, 'secret version ID');
    requireValue(Object.keys(value).every((key) => ['key', 'arn', 'versionId'].includes(key)), 'Secret plaintext is forbidden in artifacts.');
  }
  return values.map((v) => ({ key: v.key, arn: v.arn, versionId: v.versionId }));
}
export function validateScope(input, profile) {
  requireValue(input && input.profile === profile && PROFILES.includes(profile), 'Unsupported hosting profile.');
  const s = input.scope;
  requireValue(s && typeof s === 'object', 'An immutable deployment scope is required.');
  exactKeys(s, ['organizationId', 'projectId', 'bindingId', 'operationId', 'generationId', 'planId', 'accountId', 'region', 'environment', 'sourceSha', 'planFingerprint', 'configurationFingerprint', 'bindingVersion', 'stateBucket'], 'deployment scope');
  for (const key of ['organizationId', 'projectId', 'bindingId', 'operationId', 'generationId', 'planId']) uuid(s[key], key);
  text(s.accountId, /^\d{12}$/, 'AWS account'); text(s.region, /^(us|eu|ap|ca|sa|me|af|il|mx)-[a-z]+-\d$/, 'AWS region');
  text(s.environment, /^(production|staging|sandbox|development)$/, 'environment');
  text(s.sourceSha, /^[a-f0-9]{40}$/, 'source SHA'); sha(s.planFingerprint, 'plan fingerprint'); sha(s.configurationFingerprint, 'configuration fingerprint');
  boundedNumber(s.bindingVersion, 1, 2147483647, 'binding version', true);
  text(s.stateBucket, /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/, 'state bucket');
  requireValue(!s.stateBucket.includes('..') && !/^\d+\.\d+\.\d+\.\d+$/.test(s.stateBucket), 'Invalid state bucket.');
  requireValue(input.plan && fingerprint(input.plan) === s.planFingerprint, 'The immutable approved plan fingerprint does not match.');
  const ownership = input.plan.ownership;
  requireValue(input.plan.selectedProfile === profile && input.plan.operationId === s.operationId && input.plan.configurationFingerprint === s.configurationFingerprint && input.plan.repository?.sourceSha === s.sourceSha, 'Profile, source or configuration differs from the immutable plan.');
  requireValue(ownership && ['organizationId', 'bindingId', 'accountId', 'bindingVersion', 'region', 'environment'].every((key) => ownership[key] === s[key]), 'Account or ownership differs from the immutable plan.');
  requireValue(['blocked', 'review_required'].includes(input.plan.status) && Array.isArray(input.plan.blockers), 'The immutable plan review state is required.');
  requireValue(input.plan.profileInputs && fingerprint(input.plan.profileInputs) === fingerprint(input.configuration), 'Profile configuration must be sealed into the approved plan.');
  requireValue(input.plan.projectId === s.projectId && input.plan.generationId === s.generationId, 'Generation and project must be sealed into the approved plan.');
  // Approval is revalidated by the executor against durable records; JSON cannot confer authority.
  requireValue(!Object.keys(input).some((key) => /credential|password|token|private.?key|access.?key/i.test(key)), 'Credentials must remain inside the customer session callback.');
  return structuredClone(s);
}
export function baseTerraform(scope) {
  return {
    terraform: { required_version: '>= 1.10.0, < 2.0.0', required_providers: { aws: { source: 'hashicorp/aws', version: AWS_PROVIDER_VERSION } }, backend: { s3: {} } },
    provider: { aws: { region: scope.region, allowed_account_ids: [scope.accountId], default_tags: { tags: ownershipTags(scope) } } },
    data: { aws_caller_identity: { current: {} } }, resource: {}, output: {},
  };
}
export function ownershipTags(s) {
  return { ManagedBy: 'DeployGuard', OrganizationId: s.organizationId, ProjectId: s.projectId, Environment: s.environment, GenerationId: s.generationId, OperationId: s.operationId, SourceSHA: s.sourceSha, PlanFingerprint: s.planFingerprint };
}
export function resourceName(scope) { return `dg-${scope.projectId.replaceAll('-', '').slice(0, 12)}-${scope.generationId.replaceAll('-', '').slice(0, 12)}`; }
export function addResource(tf, type, name, body) { (tf.resource[type] ||= {})[name] = body; }
export function item(category, service, dimension, quantity, unit, kind = 'fixed') {
  return { category, service, dimension, quantity, unit, kind, monthlyUsd: null, reason: 'A current regional price and workload-specific quote are required.' };
}
export function finish(input, scope, tf, files, costs, compatibility, identity) {
  const addresses = Object.entries(tf.resource).flatMap(([type, named]) => Object.keys(named).map((name) => `${type}.${name}`)).sort();
  const artifactFiles = { 'main.tf.json': JSON.stringify(tf, null, 2) + '\n', ...files };
  const manifest = {
    contractVersion: CONTRACT_VERSION, profile: input.profile, scope, providerVersion: AWS_PROVIDER_VERSION,
    stateKey: `organizations/${scope.organizationId}/projects/${scope.projectId}/${scope.environment}/profiles/${input.profile}/generations/${scope.generationId}/terraform.tfstate`,
    backend: { bucket: scope.stateBucket, region: scope.region, encrypt: true, use_lockfile: true },
    files: Object.fromEntries(Object.entries(artifactFiles).map(([name, data]) => [name, createHash('sha256').update(data).digest('hex')])),
    ownedResourceAddresses: addresses, ownershipTags: ownershipTags(scope), runtimeIdentity: identity,
    ...(['ec2', 'lightsail'].includes(input.profile) ? { dnsZoneId: input.configuration.dns.zoneId } : {}),
    compatibility, cost: { status: 'unpriced', currency: 'USD', items: costs, overlap: 'Previous verified generations remain billed during the rollback retention window.' },
    authority: { available: false, approvalRequired: true, customerSessionRequired: true, liveProviderVerification: 'not_performed' },
    rollback: { strategy: 'retained_generation', requiresFreshOwnershipAndHealth: true, canonicalRouteCompareAndSwap: true, preservePreviousOnFailure: true, migrateDatabase: false },
    cleanup: { requiresApprovedDeletionScope: true, denyActiveOrRollbackRetainedGeneration: true, exactStateKey: true, addresses, deleteDatabase: false, deleteSecret: false, deleteSharedNetwork: false },
  };
  manifest.artifactFingerprint = fingerprint(manifest);
  return { manifest, files: artifactFiles };
}
