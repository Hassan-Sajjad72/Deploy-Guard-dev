import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile, mkdir, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONTRACT_VERSION, fingerprint, requireValue } from './contracts.mjs';

const executeFile = promisify(execFile);
const terraformVersion = '1.10.5';
const cryptoHash = (data) => createHash('sha256').update(data).digest('hex');
const defaultRun = async (file, args, options) => {
  try {
    const { stdout } = await executeFile(file, args, { ...options, timeout: 15 * 60 * 1000, maxBuffer: 32 * 1024 * 1024 });
    return stdout;
  } catch { throw new Error(`${file === 'terraform' ? 'Terraform' : 'Provider'} command failed; the previous verified generation is retained.`); }
};

export function assertArtifacts(artifacts) {
  const m = artifacts?.manifest;
  requireValue(m?.contractVersion === CONTRACT_VERSION && m.providerVersion === '5.100.0', 'Unsupported hosting artifact contract or provider pin.');
  const { artifactFingerprint, ...unsigned } = m;
  requireValue(artifactFingerprint === fingerprint(unsigned), 'Hosting manifest fingerprint changed.');
  requireValue(Object.keys(artifacts.files).length === Object.keys(m.files).length && Object.entries(m.files).every(([path, hash]) =>
    /^[A-Za-z0-9][A-Za-z0-9_.-]{0,100}$/.test(path) && typeof artifacts.files[path] === 'string' && cryptoHash(artifacts.files[path]) === hash), 'An executable artifact changed or has an unsafe path.');
  requireValue(m.ownedResourceAddresses.length && new Set(m.ownedResourceAddresses).size === m.ownedResourceAddresses.length && m.cleanup.deleteDatabase === false && m.cleanup.deleteSharedNetwork === false && m.cleanup.deleteSecret === false, 'Cleanup may only target the owned compute generation.');
  return m;
}

// The authority is a trusted server adapter, never a JSON approval supplied by the caller.
// Its methods must read fresh DB membership/binding/immutable approval and persist strict audit.
function authorityMethods(authority) {
  for (const name of ['withCustomerSession', 'assertCurrent', 'recordEvidence', 'verifyRuntimeOwnership', 'probeHealth', 'promoteCompareAndSwap', 'getRetainedGeneration', 'assertCleanup']) {
    requireValue(typeof authority?.[name] === 'function', `The durable ${name} authority adapter is required.`);
  }
}
function scopedEnvironment(session, scope) {
  requireValue(session?.accountId === scope.accountId && session.region === scope.region && session.credentials?.sessionToken, 'Fresh temporary credentials for the exact approved account and region are required.');
  requireValue(Number.isFinite(Date.parse(session.expiresAt)) && Date.parse(session.expiresAt) > Date.now() && Date.parse(session.expiresAt) <= Date.now() + 20 * 60 * 1000, 'The customer session must be current and time limited.');
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('AWS_') && !key.startsWith('TF_')));
  return { ...env, AWS_ACCESS_KEY_ID: session.credentials.accessKeyId, AWS_SECRET_ACCESS_KEY: session.credentials.secretAccessKey, AWS_SESSION_TOKEN: session.credentials.sessionToken,
    AWS_REGION: scope.region, AWS_DEFAULT_REGION: scope.region, AWS_CONFIG_FILE: '/dev/null', AWS_SHARED_CREDENTIALS_FILE: '/dev/null', AWS_EC2_METADATA_DISABLED: 'true', TF_IN_AUTOMATION: '1', TF_INPUT: '0' };
}
async function current(authority, manifest, action) {
  const proof = await authority.assertCurrent({ scope: manifest.scope, profile: manifest.profile, action, artifactFingerprint: manifest.artifactFingerprint });
  requireValue(proof?.planFingerprint === manifest.scope.planFingerprint && proof.artifactFingerprint === manifest.artifactFingerprint && proof.bindingVersion === manifest.scope.bindingVersion && proof.approval === 'approved' && proof.profileAvailable === true && proof.pricingStatus === 'complete', 'Current approval, account binding, provider availability and complete pricing are required.');
  return proof;
}
async function workspace(artifacts, loadAsset) {
  const dir = await mkdtemp(join(tmpdir(), 'deployguard-profile-')); await chmod(dir, 0o700);
  try {
    for (const [name, data] of Object.entries(artifacts.files)) await writeFile(join(dir, name), data, { mode: 0o600 });
    const lock = await readFile(new URL('../railpack-runtime/.terraform.lock.hcl', import.meta.url), 'utf8');
    const awsBlock = lock.match(/provider "registry\.terraform\.io\/hashicorp\/aws" \{[\s\S]*?\n\}/)?.[0];
    requireValue(awsBlock?.includes('version     = "5.100.0"'), 'The existing pinned AWS provider lock is missing.');
    await writeFile(join(dir, '.terraform.lock.hcl'), awsBlock.replace('constraints = "~> 5.0"', 'constraints = "5.100.0"') + '\n', { mode: 0o600 });
    let assets = [];
    if (artifacts.manifest.profile === 'static') assets = JSON.parse(artifacts.files['assets-manifest.json']).files;
    if (artifacts.manifest.profile === 'lambda') assets = [JSON.parse(artifacts.files['lambda-artifact-manifest.json'])];
    requireValue(!assets.length || typeof loadAsset === 'function', 'Immutable build asset loading is required.');
    for (const asset of assets) {
      const data = await loadAsset({ sourceSha: artifacts.manifest.scope.sourceSha, generationId: artifacts.manifest.scope.generationId, path: asset.path, sha256: asset.sha256 });
      requireValue(Buffer.isBuffer(data) && data.length === asset.bytes && cryptoHash(data) === asset.sha256, 'A source-pinned build asset changed.');
      const dest = resolve(dir, 'assets', asset.path); requireValue(dest.startsWith(resolve(dir, 'assets') + '/'), 'Unsafe asset path.');
      await mkdir(dirname(dest), { recursive: true, mode: 0o700 }); await writeFile(dest, data, { mode: 0o600 });
    }
    return dir;
  } catch (error) { await rm(dir, { recursive: true, force: true }); throw error; }
}
async function initialize(run, dir, env, m) {
  const version = JSON.parse(await run('terraform', ['version', '-json'], { cwd: dir, env }));
  requireValue(version.terraform_version === terraformVersion, 'The common pinned Terraform 1.10.5 runtime is required.');
  await run('terraform', ['init', '-input=false', '-reconfigure', '-lockfile=readonly', `-backend-config=bucket=${m.backend.bucket}`, `-backend-config=key=${m.stateKey}`, `-backend-config=region=${m.backend.region}`, '-backend-config=encrypt=true', '-backend-config=use_lockfile=true'], { cwd: dir, env });
  await run('terraform', ['validate', '-json'], { cwd: dir, env });
}
export function inspectPlan(plan, manifest, action) {
  requireValue(plan && Array.isArray(plan.resource_changes), 'A provider Terraform plan is required.');
  const allowed = new Set(manifest.ownedResourceAddresses);
  const changes = plan.resource_changes.filter((v) => v.mode !== 'data');
  requireValue(changes.every((v) => allowed.has(v.address) && !v.deposed && !v.importing && !v.change?.importing), 'A Terraform plan touches resources outside the approved generation.');
  const approved = action === 'cleanup' ? ['delete', 'no-op'] : ['create', 'no-op'];
  requireValue(changes.every((v) => Array.isArray(v.change?.actions) && v.change.actions.length === 1 && approved.includes(v.change.actions[0])), 'Updates and replacements require a new immutable generation plan.');
  if (action === 'deploy') requireValue(changes.length === allowed.size && changes.every((v) => v.change.actions[0] === 'create'), 'A candidate generation must be wholly new; an existing or partial state requires reconciliation.');
  if (action === 'cleanup') requireValue(changes.length === allowed.size && changes.every((v) => v.change.actions[0] === 'delete'), 'Cleanup requires the complete exact owned generation, with no retained or unknown resources.');
  return { fingerprint: fingerprint(plan), resourceChanges: changes.map((v) => ({ address: v.address, actions: v.change.actions })) };
}
async function runtimeProof(authority, manifest, identity) {
  requireValue(identity && identity.generationId === manifest.scope.generationId && identity.sourceSha === manifest.scope.sourceSha, 'Provider output differs from the approved source or generation.');
  const ownership = await authority.verifyRuntimeOwnership({ scope: manifest.scope, profile: manifest.profile, identity, manifest });
  requireValue(ownership?.status === 'verified' && ownership.accountId === manifest.scope.accountId && ownership.region === manifest.scope.region && ownership.resourceFingerprint === fingerprint(identity), 'Fresh provider ownership, source and endpoint verification are required.');
  const health = await authority.probeHealth({ scope: manifest.scope, identity, manifest, ownership, timeoutSeconds: 45, requestTimeoutSeconds: 5 });
  requireValue(health?.status === 'healthy' && health.resourceFingerprint === fingerprint(identity) && health.sourceSha === manifest.scope.sourceSha && Number.isFinite(Date.parse(health.observedAt)) && Date.now() - Date.parse(health.observedAt) >= 0 && Date.now() - Date.parse(health.observedAt) <= 60000, 'A fresh bounded TLS application health result is required.');
  return { ownership, health };
}

export async function executeGeneration(artifacts, authority, { runCommand = defaultRun, loadAsset } = {}) {
  const manifest = assertArtifacts(artifacts); authorityMethods(authority);
  await current(authority, manifest, 'deploy');
  return authority.withCustomerSession({ ...manifest.scope, profile: manifest.profile, purpose: 'deploy' }, async (session) => {
    const env = scopedEnvironment(session, manifest.scope), dir = await workspace(artifacts, loadAsset); let applied = false;
    try {
      await initialize(runCommand, dir, env, manifest);
      await runCommand('terraform', ['plan', '-input=false', '-lock-timeout=60s', '-out=candidate.tfplan'], { cwd: dir, env });
      const plan = JSON.parse(await runCommand('terraform', ['show', '-json', 'candidate.tfplan'], { cwd: dir, env }));
      const summary = inspectPlan(plan, manifest, 'deploy');
      await current(authority, manifest, 'deploy');
      await authority.recordEvidence({ action: 'HOSTING_PROVIDER_APPLY_ADMITTED', scope: manifest.scope, profile: manifest.profile, artifactFingerprint: manifest.artifactFingerprint, plan: summary });
      // Apply only the inspected saved plan; no second unconstrained planning pass.
      await runCommand('terraform', ['apply', '-input=false', '-lock-timeout=60s', 'candidate.tfplan'], { cwd: dir, env }); applied = true;
      const outputs = JSON.parse(await runCommand('terraform', ['output', '-json'], { cwd: dir, env }));
      const identity = outputs.runtime_identity?.value;
      const proof = await runtimeProof(authority, manifest, identity);
      await current(authority, manifest, 'promote');
      const promoted = await authority.promoteCompareAndSwap({ scope: manifest.scope, manifest, identity, proof });
      requireValue(promoted?.status === 'promoted' && promoted.generationId === manifest.scope.generationId, 'The canonical route changed; candidate resources require reconciliation.');
      await authority.recordEvidence({ action: 'HOSTING_GENERATION_PROMOTED', scope: manifest.scope, profile: manifest.profile, artifactFingerprint: manifest.artifactFingerprint, identity, proof });
      return { status: 'verified', identity, artifactFingerprint: manifest.artifactFingerprint, proof };
    } catch (error) {
      await authority.recordEvidence({ action: 'HOSTING_GENERATION_FAILED', scope: manifest.scope, profile: manifest.profile, artifactFingerprint: manifest.artifactFingerprint, outcome: applied ? 'candidate_retained_for_reconciliation' : 'apply_not_confirmed', previousGenerationPreserved: true });
      throw error;
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
}

export async function rollbackGeneration(targetScope, targetGenerationId, authority) {
  authorityMethods(authority);
  const retained = await authority.getRetainedGeneration({ scope: targetScope, generationId: targetGenerationId });
  const manifest = assertArtifacts(retained?.artifacts);
  requireValue(['organizationId', 'projectId', 'accountId', 'bindingId', 'bindingVersion', 'region', 'environment'].every((key) => manifest.scope[key] === targetScope[key]), 'Rollback cannot cross customer, project, environment or binding scope.');
  requireValue(retained.status === 'verified' && retained.retainedUntil && Date.parse(retained.retainedUntil) > Date.now(), 'The exact verified previous generation must still be retained.');
  await current(authority, manifest, 'rollback');
  return authority.withCustomerSession({ ...targetScope, profile: manifest.profile, purpose: 'rollback_read' }, async (session) => {
    scopedEnvironment(session, targetScope);
    const proof = await runtimeProof(authority, manifest, retained.identity);
    await current(authority, manifest, 'rollback');
    await authority.recordEvidence({ action: 'HOSTING_ROLLBACK_ADMITTED', scope: targetScope, targetGenerationId, artifactFingerprint: manifest.artifactFingerprint, proof });
    const promoted = await authority.promoteCompareAndSwap({ scope: targetScope, manifest, identity: retained.identity, proof, rollback: true });
    requireValue(promoted?.status === 'promoted' && promoted.generationId === targetGenerationId, 'Rollback canonical route comparison failed; the active generation remains unchanged.');
    await authority.recordEvidence({ action: 'HOSTING_ROLLBACK_PROMOTED', scope: targetScope, targetGenerationId, artifactFingerprint: manifest.artifactFingerprint, proof });
    return { status: 'verified', identity: retained.identity, proof };
  });
}

export const parseCliJson = (output) => JSON.parse(String(output ?? '').trim() || '{}');
async function cleanArtifactVersions(run, dir, env, manifest, identity) {
  if (!['static', 'lambda'].includes(manifest.profile)) return;
  requireValue(typeof identity.bucket === 'string' && identity.bucket === `${manifest.runtimeIdentity.bucket}` && identity.objectPrefix === `generations/${manifest.scope.generationId}/`, 'Artifact bucket scope changed.');
  // The AWS CLI prints nothing for an empty listing and for a fully successful Quiet delete; errors are still returned.
  const versions = parseCliJson(await run('aws', ['s3api', 'list-object-versions', '--bucket', identity.bucket, '--prefix', identity.objectPrefix, '--expected-bucket-owner', manifest.scope.accountId, '--output', 'json'], { cwd: dir, env }));
  const entries = [...(versions.Versions || []), ...(versions.DeleteMarkers || [])];
  requireValue(entries.length <= 10000 && !versions.IsTruncated && entries.every((v) => v.Key.startsWith(identity.objectPrefix) && typeof v.VersionId === 'string'), 'Object version cleanup exceeds the bounded owned generation.');
  for (let i = 0; i < entries.length; i += 1000) {
    const batch = entries.slice(i, i + 1000).map((v) => ({ Key: v.Key, VersionId: v.VersionId }));
    const result = parseCliJson(await run('aws', ['s3api', 'delete-objects', '--bucket', identity.bucket, '--expected-bucket-owner', manifest.scope.accountId, '--delete', JSON.stringify({ Objects: batch, Quiet: true }), '--output', 'json'], { cwd: dir, env }));
    requireValue(!result.Errors?.length, 'An artifact version could not be deleted; shared resources remain untouched.');
  }
}
export async function cleanupGeneration(artifacts, identity, authority, { runCommand = defaultRun, loadAsset } = {}) {
  const manifest = assertArtifacts(artifacts); authorityMethods(authority);
  const deletion = await authority.assertCleanup({ scope: manifest.scope, artifactFingerprint: manifest.artifactFingerprint, identity });
  requireValue(deletion?.status === 'approved' && deletion.generationActive === false && deletion.rollbackRetained === false && deletion.resourceFingerprint === fingerprint(identity), 'Cleanup requires approved deletion and fresh inactive/retention checks.');
  return authority.withCustomerSession({ ...manifest.scope, profile: manifest.profile, purpose: 'cleanup' }, async (session) => {
    const env = scopedEnvironment(session, manifest.scope), dir = await workspace(artifacts, loadAsset);
    try {
      const ownership = await authority.verifyRuntimeOwnership({ scope: manifest.scope, profile: manifest.profile, identity, manifest });
      requireValue(ownership?.status === 'verified' && ownership.accountId === manifest.scope.accountId && ownership.region === manifest.scope.region && ownership.resourceFingerprint === fingerprint(identity), 'Cleanup must freshly verify exact provider ownership.');
      await initialize(runCommand, dir, env, manifest);
      await runCommand('terraform', ['plan', '-destroy', '-input=false', '-lock-timeout=60s', '-out=cleanup.tfplan'], { cwd: dir, env });
      const plan = JSON.parse(await runCommand('terraform', ['show', '-json', 'cleanup.tfplan'], { cwd: dir, env }));
      const summary = inspectPlan(plan, manifest, 'cleanup');
      const fresh = await authority.assertCleanup({ scope: manifest.scope, artifactFingerprint: manifest.artifactFingerprint, identity });
      requireValue(fresh?.status === 'approved' && fresh.generationActive === false && fresh.rollbackRetained === false && fresh.resourceFingerprint === fingerprint(identity), 'Generation activation or retention changed during cleanup.');
      await authority.recordEvidence({ action: 'HOSTING_GENERATION_CLEANUP_ADMITTED', scope: manifest.scope, profile: manifest.profile, artifactFingerprint: manifest.artifactFingerprint, plan: summary });
      await cleanArtifactVersions(runCommand, dir, env, manifest, identity);
      await runCommand('terraform', ['apply', '-input=false', '-lock-timeout=60s', 'cleanup.tfplan'], { cwd: dir, env });
      await authority.recordEvidence({ action: 'HOSTING_GENERATION_CLEANUP_COMPLETED', scope: manifest.scope, profile: manifest.profile, artifactFingerprint: manifest.artifactFingerprint });
      return { status: 'deleted', generationId: manifest.scope.generationId, databasePreserved: true, sharedNetworkPreserved: true };
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
}
