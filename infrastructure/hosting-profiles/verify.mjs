import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { buildHostingArtifacts, fingerprint } from './index.mjs';
import { assertArtifacts, cleanupGeneration, executeGeneration, inspectPlan, rollbackGeneration } from './runtime.mjs';

const exec = promisify(execFile);
const root = resolve(new URL('../..', import.meta.url).pathname);
const hash = (v) => createHash('sha256').update(v).digest('hex');
const sourceSha = 'a'.repeat(40), serviceId = randomUUID();
const index = Buffer.from('<!doctype html><title>approved source build</title>');
const zip = Buffer.from('verified-zip-fixture-bytes');
export function fixture(profile) {
  const scope = { organizationId: randomUUID(), projectId: randomUUID(), bindingId: randomUUID(), operationId: randomUUID(), generationId: randomUUID(), planId: randomUUID(), accountId: '123456789012', region: 'us-east-1', environment: 'staging', sourceSha, configurationFingerprint: 'b'.repeat(64), bindingVersion: 1, stateBucket: 'approved-customer-state-bucket' };
  const configuration = ['ec2', 'lightsail'].includes(profile) ? {
    availability: 'single_instance', replicas: 1, localPersistence: false, architecture: 'amd64', entrypointServiceId: serviceId, healthPath: '/health',
    services: [{ id: serviceId, image: 'public.ecr.aws/verified/app@sha256:' + 'c'.repeat(64), port: 3000, cpu: .5, memoryMiB: 256, runAs: '1000:1000', publicEnvironment: { NODE_ENV: { publicValue: 'production' } }, secretReferences: [] }],
    proxy: { kind: 'caddy', image: 'public.ecr.aws/verified/caddy@sha256:' + 'd'.repeat(64), verifiedDigest: true }, dns: { zoneId: 'Z1234567890', zoneName: 'authorized.example.com' },
    ...(profile === 'ec2' ? { ami: { id: 'ami-1234567890abcdef0', ownerId: '137112412989', architecture: 'x86_64', os: 'amazon_linux_2023' }, instanceType: 't3.small', vpcId: 'vpc-1234567890abcdef0', subnetId: 'subnet-1234567890abcdef0', rootStorageGiB: 20, instanceCpu: 2, instanceMemoryMiB: 2048 }
      : { blueprint: { id: 'ubuntu_22_04', os: 'ubuntu_22_04' }, bundle: { id: 'verified-small-bundle', cpu: 2, memoryMiB: 1024, storageGiB: 40, includedTransferGiB: 1000 }, availabilityZone: 'us-east-1a' }),
  } : profile === 'static' ? { build: { sourceSha, kind: 'static', fingerprint: 'e'.repeat(64), securityScanFingerprint: 'f'.repeat(64), status: 'verified' }, assets: [{ path: 'index.html', bytes: index.length, sha256: hash(index), contentType: 'text/html' }], spa: true, priceClass: 'PriceClass_100', healthPath: '/' }
    : { build: { sourceSha, kind: 'lambda_http', fingerprint: 'e'.repeat(64), securityScanFingerprint: 'f'.repeat(64), status: 'verified' }, serviceId, architecture: 'amd64', runtime: 'nodejs22.x', handler: 'index.handler', artifact: { bytes: zip.length, uncompressedBytes: 1024, sha256: hash(zip) }, adapter: { kind: 'native_http', fingerprint: 'e'.repeat(64), payloadFormat: '2.0', timeoutBounded: true, filesystemEphemeral: true, backgroundWorkers: false, maximumRequestBytes: 65536, maximumResponseBytes: 65536 }, publicEnvironment: {}, secretReferences: [], timeoutSeconds: 15, memoryMiB: 512, ephemeralStorageMiB: 512, reservedConcurrency: 5, requestsPerSecond: 10, burstLimit: 20, healthPath: '/health', authorization: 'public_application_endpoint' };
  const plan = { projectId: scope.projectId, generationId: scope.generationId, operationId: scope.operationId, ownership: { organizationId: scope.organizationId, bindingId: scope.bindingId, bindingVersion: 1, accountId: scope.accountId, region: scope.region, environment: scope.environment }, repository: { sourceSha }, configurationFingerprint: scope.configurationFingerprint, selectedProfile: profile, profileInputs: configuration, assumptions: { stateful: false, continuousCompute: ['ec2', 'lightsail'].includes(profile), storageGiB: 20, monthlyRequests: 1000, monthlyTransferGiB: 10, monthlyLogGiB: 1 }, services: [{ id: serviceId, port: 3000, buildTarget: { status: 'resolved', sourceSha, architecture: 'amd64' } }], environmentReferences: [], dependencies: { database: null }, infrastructure: { vpcId: 'vpc-1234567890abcdef0', publicSubnetIds: ['subnet-1234567890abcdef0'], terraformStateBucket: scope.stateBucket }, status: 'review_required', blockers: [] };
  scope.planFingerprint = fingerprint(plan); return { profile, scope, plan, configuration };
}
function reseal(input) { input.plan.profileInputs = input.configuration; input.scope.planFingerprint = fingerprint(input.plan); return input; }
function tfPlan(m, action = 'create') { return { resource_changes: m.ownedResourceAddresses.map((address) => ({ address, mode: 'managed', change: { actions: [action] } })) }; }

async function main() {
  const artifacts = Object.fromEntries(['ec2', 'lightsail', 'static', 'lambda'].map((profile) => [profile, buildHostingArtifacts(fixture(profile))]));
  for (const a of Object.values(artifacts)) {
    assert.equal(assertArtifacts(a).authority.available, false); assert.equal(a.manifest.cost.status, 'unpriced');
    assert(a.manifest.cost.items.every((item) => item.monthlyUsd === null));
    assert.equal(a.manifest.cleanup.deleteDatabase, false); assert.equal(a.manifest.rollback.preservePreviousOnFailure, true);
    assert.doesNotMatch(JSON.stringify(a), /AWS_SECRET_ACCESS_KEY|AWS_ACCESS_KEY_ID/);
    inspectPlan(tfPlan(a.manifest), a.manifest, 'deploy');
    assert.throws(() => inspectPlan(tfPlan(a.manifest, 'update'), a.manifest, 'deploy'));
    assert.throws(() => inspectPlan({ resource_changes: [...tfPlan(a.manifest).resource_changes, { address: 'aws_db_instance.shared', mode: 'managed', change: { actions: ['create'] } }] }, a.manifest, 'deploy'));
  }
  assert.equal(JSON.parse(artifacts.ec2.files['main.tf.json']).resource.aws_instance.runtime.metadata_options.http_tokens, 'required');
  assert.equal(JSON.parse(artifacts.lightsail.files['main.tf.json']).resource.aws_lightsail_instance_public_ports.runtime.port_info.length, 2);
  const changed = structuredClone(artifacts.ec2); changed.files['bootstrap.sh'] += 'echo modified\n'; assert.throws(() => assertArtifacts(changed));
  const unsafe = fixture('ec2'); unsafe.configuration.services[0].publicEnvironment.PASSWORD = { publicValue: 'never-save' }; assert.throws(() => buildHostingArtifacts(reseal(unsafe)), /Sensitive/);
  const privateImage = fixture('lightsail'); privateImage.configuration.services[0].image = '123456789012.dkr.ecr.us-east-1.amazonaws.com/dg-123-app@sha256:' + '1'.repeat(64); assert.throws(() => buildHostingArtifacts(reseal(privateImage)), /private image/);
  const secret = fixture('lightsail'); secret.configuration.services[0].secretReferences = [{ key: 'DB_PASSWORD', arn: `arn:aws:secretsmanager:us-east-1:123456789012:secret:dg-${secret.scope.projectId.replaceAll('-', '').slice(0, 12)}-db-ABC123`, versionId: 'a'.repeat(32) }]; assert.throws(() => buildHostingArtifacts(reseal(secret)), /Lightsail has no/);
  const ec2Secret = fixture('ec2'); ec2Secret.configuration.services[0].secretReferences = [{ key: 'DB_PASSWORD', arn: `arn:aws:secretsmanager:us-east-1:123456789012:secret:dg-${ec2Secret.scope.projectId.replaceAll('-', '').slice(0, 12)}-db-ABC123`, versionId: 'a'.repeat(32) }];
  const withSecret = buildHostingArtifacts(reseal(ec2Secret)); assert.match(withSecret.files['bootstrap.sh'], /get-secret-value/); assert.doesNotMatch(withSecret.files['bootstrap.sh'], /SecretString['"]?\s*:/);
  const wrongSource = fixture('ec2'); wrongSource.plan.repository.sourceSha = 'f'.repeat(40); wrongSource.scope.planFingerprint = fingerprint(wrongSource.plan); assert.throws(() => buildHostingArtifacts(wrongSource), /source/);
  const badAsset = fixture('static'); badAsset.configuration.assets[0].path = '../index.html'; assert.throws(() => buildHostingArtifacts(reseal(badAsset)), /Invalid artifact|Unsafe artifact/);
  const stateful = fixture('lambda'); stateful.plan.assumptions.stateful = true; stateful.scope.planFingerprint = fingerprint(stateful.plan); assert.throws(() => buildHostingArtifacts(stateful), /stateful/);
  const tooLong = fixture('lambda'); tooLong.configuration.timeoutSeconds = 900; assert.throws(() => buildHostingArtifacts(reseal(tooLong)), /timeout/);
  const m = artifacts.ec2.manifest, calls = [], evidence = []; let healthy = true, approved = true, retained = false, promoteCalls = 0;
  const identity = { instanceId: 'i-1234567890abcdef0', endpoint: m.runtimeIdentity.endpoint, sourceSha: m.scope.sourceSha, generationId: m.scope.generationId };
  const authority = {
    assertCurrent: async () => ({ planFingerprint: m.scope.planFingerprint, artifactFingerprint: m.artifactFingerprint, bindingVersion: m.scope.bindingVersion, approval: approved ? 'approved' : 'revoked', profileAvailable: true, pricingStatus: 'complete' }),
    withCustomerSession: async (_scope, cb) => cb({ accountId: m.scope.accountId, region: m.scope.region, expiresAt: new Date(Date.now() + 900000).toISOString(), credentials: { accessKeyId: 'temporary-key', secretAccessKey: 'temporary-secret', sessionToken: 'temporary-token' } }),
    recordEvidence: async (e) => { assert.doesNotMatch(JSON.stringify(e), /temporary-/); evidence.push(e); },
    verifyRuntimeOwnership: async () => ({ status: 'verified', accountId: m.scope.accountId, region: m.scope.region, resourceFingerprint: fingerprint(identity) }),
    probeHealth: async () => ({ status: healthy ? 'healthy' : 'failed', resourceFingerprint: fingerprint(identity), sourceSha: m.scope.sourceSha, observedAt: new Date().toISOString() }),
    promoteCompareAndSwap: async () => { promoteCalls++; return { status: 'promoted', generationId: m.scope.generationId }; },
    getRetainedGeneration: async () => ({ artifacts: artifacts.ec2, identity, status: 'verified', retainedUntil: new Date(Date.now() + 86400000).toISOString() }),
    assertCleanup: async () => ({ status: 'approved', generationActive: false, rollbackRetained: retained, resourceFingerprint: fingerprint(identity) }),
  };
  const runCommand = async (file, args, options) => {
    assert.equal(file, 'terraform'); assert.equal(options.env.AWS_SESSION_TOKEN, 'temporary-token'); assert.equal(options.env.AWS_SHARED_CREDENTIALS_FILE, '/dev/null');
    calls.push(args);
    if (args[0] === 'version') return JSON.stringify({ terraform_version: '1.10.5' });
    if (args[0] === 'show') return JSON.stringify(tfPlan(m, args.includes('cleanup.tfplan') ? 'delete' : 'create'));
    if (args[0] === 'output') return JSON.stringify({ runtime_identity: { value: identity } });
    return '{}';
  };
  assert.equal((await executeGeneration(artifacts.ec2, authority, { runCommand })).status, 'verified');
  assert(calls.some((args) => args[0] === 'apply' && args.at(-1) === 'candidate.tfplan'));
  assert.equal(promoteCalls, 1); healthy = false;
  await assert.rejects(() => executeGeneration(artifacts.ec2, authority, { runCommand }), /health/); assert.equal(promoteCalls, 1);
  assert(evidence.some((v) => v.action === 'HOSTING_GENERATION_FAILED' && v.previousGenerationPreserved)); healthy = true;
  assert.equal((await rollbackGeneration(m.scope, m.scope.generationId, authority)).status, 'verified');
  approved = false; const before = calls.length; await assert.rejects(() => executeGeneration(artifacts.ec2, authority, { runCommand })); assert.equal(calls.length, before); approved = true;
  retained = true; await assert.rejects(() => cleanupGeneration(artifacts.ec2, identity, authority, { runCommand })); retained = false;
  assert.equal((await cleanupGeneration(artifacts.ec2, identity, authority, { runCommand })).databasePreserved, true);
  // Actual local provider-schema validation; init is explicitly backend disabled and only uses the existing cached provider.
  const providerDir = join(root, 'infrastructure/railpack-runtime/.terraform/providers');
  for (const [profile, a] of Object.entries(artifacts)) {
    const dir = await mkdtemp(join(tmpdir(), 'dg-profile-validate-'));
    try {
      const tf = JSON.parse(a.files['main.tf.json']); delete tf.terraform.backend;
      await writeFile(join(dir, 'main.tf.json'), JSON.stringify(tf));
      await exec('terraform', [`-chdir=${dir}`, 'init', '-backend=false', '-get=false', `-plugin-dir=${providerDir}`], { maxBuffer: 1024 ** 2 });
      const validated = await exec('terraform', [`-chdir=${dir}`, 'validate', '-json'], { maxBuffer: 1024 ** 2 }).catch((e) => ({ stdout: e.stdout }));
      const result = JSON.parse(validated.stdout); assert.equal(result.valid, true, JSON.stringify({ profile, diagnostics: result.diagnostics }));
      if (a.files['bootstrap.sh']) {
        await writeFile(join(dir, 'bootstrap.sh'), a.files['bootstrap.sh']); await exec('bash', ['-n', join(dir, 'bootstrap.sh')]);
        const python = a.files['bootstrap.sh'].split("<<'DG_RUNTIME'\n")[1].split('\nDG_RUNTIME')[0];
        await writeFile(join(dir, 'start.py'), python); await exec('python3', ['-m', 'py_compile', join(dir, 'start.py')]);
      }
    } finally { await rm(dir, { recursive: true, force: true }); }
  }
  console.log('Focused hosting profile ownership, immutable artifact, runtime orchestration, rollback, cleanup and local Terraform schema checks passed. No AWS calls were made.');
}
if (process.argv[1] === new URL(import.meta.url).pathname) main().catch((e) => { console.error(e); process.exitCode = 1; });
