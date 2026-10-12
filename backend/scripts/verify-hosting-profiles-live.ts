// Real-AWS verification of hosting profiles (static, lambda, ec2, lightsail) through the production runtime:
// deploy two generations, observe, roll back, clean up, then independently prove removal.
// Gated by explicit flags. Credentials stay in-process and are never logged.
// Usage: npm run verify:hosting-live -- <static|lambda|ec2|lightsail> --aws-profile <name> --terraform <terraform-1.10.5>
//   [--dns-zone-id Z... --dns-zone-name test.example.com] (VMs) [--allow-verification-role] (lambda, ec2) [--state-dir <dir>] [--recover <state.json>]
import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { hostingPolicyName, hostingProviderReadPolicy, hostingProviderSessionPolicy } from "../src/planning/hosting-provider-session.service";
import { hostingExecutableFingerprint, loadHostingArtifacts, loadHostingEvidence, loadHostingRuntime } from "../src/planning/hosting-profile-inputs";
import { planFingerprint } from "../src/planning/deployment-plan";
import { buildDeterministicZip } from "../src/terraform-export/zip-builder";

const exec = promisify(execFile);
const flag = (name: string) => { const index = process.argv.indexOf(`--${name}`); return index > 0 ? process.argv[index + 1] : undefined; };
const awsProfile = flag("aws-profile") || process.env.DG_LIVE_AWS_PROFILE || "", terraform = flag("terraform") || process.env.DG_TERRAFORM_1_10_5 || "";
const dnsZone = { id: flag("dns-zone-id") || "", name: flag("dns-zone-name") || "" };
const allowRole = process.argv.includes("--allow-verification-role") || process.env.DG_LIVE_ALLOW_VERIFICATION_ROLE === "true";
const vm = (profile: string) => profile === "ec2" || profile === "lightsail";
// Digest-pinned public images: an unprivileged web app (UID 101, port 8080) behind the verified Caddy TLS proxy.
const appImage = "public.ecr.aws/nginx/nginx-unprivileged@sha256:15c994d10d6d78658721c3bcafff14cb281fba2a4bdf9d5ba92c416a472516e3";
const caddyImage = "public.ecr.aws/docker/library/caddy@sha256:d8542f48d34a9cf4e4c11a478865229840e87e4c96ea3f439101f31a5d35f75f";
const region = "us-east-1", sha = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");
const redact = (text: string) => text.replace(/\b(AKIA|ASIA)[A-Z0-9]{12,}\b/g, "<key>").replace(/[A-Za-z0-9/+=]{40,}/g, "<secret>");
const log = (message: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${message}`);
const aws = async (args: string[], allowFailure = false) => {
  try { const { stdout } = await exec("aws", [...args, "--profile", awsProfile, "--region", region, "--output", "json"], { maxBuffer: 16 * 1024 * 1024, timeout: 300_000 }); return stdout.trim() ? JSON.parse(stdout) : {}; }
  catch (error: any) { if (allowFailure) return { error: redact(String(error.stderr || error.message)) }; throw new Error(`aws ${args.slice(0, 2).join(" ")} failed: ${redact(String(error.stderr || error.message)).slice(-600)}`); }
};
const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));

type Run = { runId: string; profile: "static" | "lambda" | "ec2" | "lightsail"; network?: { vpcId: string; subnetId: string; amiId: string }; accountId: string; principalArn: string; stateBucket: string; roleName: string | null; policyArn: string | null;
  organizationId: string; projectId: string; bindingId: string; generations: Array<{ generationId: string; artifacts: any; identity: any | null; assets: Record<string, string> }> };

async function main() {
  const profile = process.argv[2] as Run["profile"];
  assert(awsProfile && terraform && ["static", "lambda", "ec2", "lightsail"].includes(profile), "Pass a profile, --aws-profile and --terraform.");
  assert(!vm(profile) || (/^Z[A-Z0-9]{4,32}$/.test(dnsZone.id) && /\./.test(dnsZone.name)), "VM profiles need --dns-zone-id and --dns-zone-name for generation TLS.");
  const identity = await aws(["sts", "get-caller-identity"]);
  if (vm(profile)) {
    const zone = await aws(["route53", "get-hosted-zone", "--id", dnsZone.id]);
    assert.equal(zone.HostedZone.Name, `${dnsZone.name}.`, "The DNS zone ID and name do not match.");
    const resolved = await exec("dig", ["+short", "NS", dnsZone.name]).then(({ stdout }) => stdout.trim()).catch(() => "");
    assert(zone.DelegationSet.NameServers.some((ns: string) => resolved.includes(ns)), `${dnsZone.name} is not yet delegated to its Route 53 zone; add the NS records first.`);
  }
  const recoverPath = flag("recover") || null;
  const run: Run = recoverPath ? JSON.parse(await readFile(recoverPath, "utf8")) : await setup(profile, identity.Account, identity.Arn);
  const statePath = recoverPath || join(flag("state-dir") || process.env.DG_LIVE_STATE_DIR || tmpdir(), `dg-live-${run.runId}.json`);
  const save = () => writeFile(statePath, JSON.stringify(run), { mode: 0o600 });
  await save(); log(`run ${run.runId} profile=${profile} account=${run.accountId} state=${statePath}`);
  const results: Record<string, string> = {};
  // Final provider proofs bind to this exact executable; the adapter computes it the same way.
  const executableFingerprint = planFingerprint(await hostingExecutableFingerprint()), startedAt = new Date().toISOString();
  try {
    if (!recoverPath) await lifecycle(run, save, results);
  } catch (error) {
    results.failure = error instanceof Error ? redact(error.message).slice(0, 800) : "unknown";
    log(`FAILURE: ${results.failure}`);
  } finally {
    await teardown(run, results);
    await verifyRemoval(run, results);
    const executableUnchanged = planFingerprint(await hostingExecutableFingerprint()) === executableFingerprint;
    if (!executableUnchanged) results.failure ||= "The hosting executable changed during the run; this evidence cannot certify any fingerprint.";
    const passed = !recoverPath && !results.failure && !Object.values(results).some((value) => value.startsWith("LEFTOVER"));
    await writeFile(join(flag("state-dir") || process.env.DG_LIVE_STATE_DIR || tmpdir(), `dg-live-${run.runId}-evidence.json`), JSON.stringify({
      contractVersion: "deployguard.live-provider-evidence/v1", runId: run.runId, profile, region, accountId: run.accountId, adapterVersion: "deployguard.hosting-provider/v1",
      executableFingerprint, executableUnchanged, startedAt, completedAt: new Date().toISOString(), passed, results }, null, 2), { mode: 0o600 });
    console.log(JSON.stringify({ runId: run.runId, profile, executableFingerprint, passed, results }, null, 2));
    if (!passed) process.exitCode = 1;
  }
}

async function setup(profile: Run["profile"], accountId: string, principalArn: string): Promise<Run> {
  const runId = randomUUID().slice(0, 8);
  // Static needs no IAM: federation tokens narrow the operator's own access with DeployGuard's session policy.
  // Lambda creates an execution role, which federation tokens cannot do; it needs an explicitly permitted role.
  const needsRole = profile === "lambda" || profile === "ec2";
  const roleName = needsRole && allowRole ? `dg-verify-${runId}` : null;
  if (needsRole && !roleName) throw new Error(`${profile} verification needs --allow-verification-role: it creates IAM roles, which federation tokens cannot do.`);
  const run: Run = { runId, profile, accountId, principalArn, stateBucket: `dg-verify-${runId}-state-${accountId}`, roleName, policyArn: null,
    organizationId: randomUUID(), projectId: randomUUID(), bindingId: randomUUID(), generations: [] };
  if (profile === "ec2") {
    const vpcId = (await aws(["ec2", "describe-vpcs", "--filters", "Name=is-default,Values=true"])).Vpcs[0].VpcId;
    const subnet = (await aws(["ec2", "describe-subnets", "--filters", `Name=vpc-id,Values=${vpcId}`, "Name=map-public-ip-on-launch,Values=true", "Name=availability-zone,Values=us-east-1a"])).Subnets[0];
    const amiId = (await aws(["ssm", "get-parameter", "--name", "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64"])).Parameter.Value;
    run.network = { vpcId, subnetId: subnet.SubnetId, amiId };
  }
  const tags = [{ Key: "ManagedBy", Value: "DeployGuardVerification" }, { Key: "VerificationRun", Value: runId }];
  await aws(["s3api", "create-bucket", "--bucket", run.stateBucket]);
  await aws(["s3api", "put-public-access-block", "--bucket", run.stateBucket, "--public-access-block-configuration", "BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true"]);
  await aws(["s3api", "put-bucket-tagging", "--bucket", run.stateBucket, "--tagging", JSON.stringify({ TagSet: tags })]);
  if (!run.roleName) return run;
  // The role is assumable only by the verifying principal; every session narrows it with DeployGuard's own session policy.
  await aws(["iam", "create-role", "--role-name", run.roleName, "--max-session-duration", "3600", "--tags", JSON.stringify(tags),
    "--assume-role-policy-document", JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { AWS: principalArn }, Action: "sts:AssumeRole" }] })]);
  await aws(["iam", "put-role-policy", "--role-name", run.roleName, "--policy-name", "verification-ceiling", "--policy-document", JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: "*", Resource: "*" }] })]);
  log("created state bucket and disposable role; waiting for IAM propagation"); await pause(15_000);
  return run;
}

function input(run: Run, generationIndex: number, failing = false) {
  const generationId = randomUUID(), operationId = randomUUID(), serviceId = "33333333-3333-4333-8333-333333333333", sourceSha = "a".repeat(40);
  const scope: any = { organizationId: run.organizationId, projectId: run.projectId, bindingId: run.bindingId, operationId, generationId, planId: randomUUID(), accountId: run.accountId, region,
    environment: "staging", sourceSha, configurationFingerprint: "b".repeat(64), bindingVersion: 1, stateBucket: run.stateBucket };
  const assets: Record<string, Buffer> = {};
  let configuration: any;
  if (run.profile === "static") {
    assets["index.html"] = Buffer.from(`<!doctype html><title>DeployGuard verification</title><p>generation ${generationIndex}</p>`);
    configuration = { build: { sourceSha, kind: "static", fingerprint: "e".repeat(64), securityScanFingerprint: "f".repeat(64), status: "verified" },
      assets: [{ path: "index.html", bytes: assets["index.html"].length, sha256: sha(assets["index.html"]), contentType: "text/html" }], spa: true, priceClass: "PriceClass_100", healthPath: "/" };
  } else if (vm(run.profile)) {
    // A failing candidate probes a path the app does not serve (404), which must never verify as healthy.
    configuration = { availability: "single_instance", replicas: 1, localPersistence: false, entrypointServiceId: serviceId, healthPath: failing ? "/dg-retry-check-missing" : "/", architecture: "amd64",
      services: [{ id: serviceId, port: 8080, cpu: run.profile === "ec2" ? .5 : .25, memoryMiB: run.profile === "ec2" ? 256 : 64, publicEnvironment: {}, secretReferences: [], image: appImage, runAs: "101:101" }],
      proxy: { kind: "caddy", image: caddyImage, verifiedDigest: true }, dns: { zoneId: dnsZone.id, zoneName: dnsZone.name },
      ...(run.profile === "ec2" ? { ami: { id: run.network!.amiId, ownerId: "137112412989", os: "amazon_linux_2023", architecture: "x86_64" }, instanceType: "t3.small", vpcId: run.network!.vpcId, subnetId: run.network!.subnetId, rootStorageGiB: 30, instanceCpu: 2, instanceMemoryMiB: 2048 }
        : { blueprint: { id: "ubuntu_22_04", os: "ubuntu_22_04" }, bundle: { id: "nano_3_0", cpu: 2, memoryMiB: 512, storageGiB: 20, includedTransferGiB: 1024, overagePricingRequired: true }, availabilityZone: "us-east-1a" }) };
  } else {
    const handler = Buffer.from(`exports.handler = async () => ({ statusCode: ${failing ? 500 : 200}, headers: { "content-type": "application/json" }, body: JSON.stringify({ ok: true, generation: ${generationIndex} }) });\n`);
    assets["function.zip"] = buildDeterministicZip([{ path: "index.js", content: handler }]);
    configuration = { build: { sourceSha, kind: "lambda_http", fingerprint: "e".repeat(64), securityScanFingerprint: "f".repeat(64), status: "verified" }, serviceId, architecture: "amd64", runtime: "nodejs22.x", handler: "index.handler",
      artifact: { sha256: sha(assets["function.zip"]), bytes: assets["function.zip"].length, uncompressedBytes: Math.max(assets["function.zip"].length, handler.length) },
      adapter: { kind: "native_http", fingerprint: sha(handler), payloadFormat: "2.0", timeoutBounded: true, filesystemEphemeral: true, backgroundWorkers: false, maximumRequestBytes: 65536, maximumResponseBytes: 65536 },
      publicEnvironment: {}, secretReferences: [], timeoutSeconds: 15, memoryMiB: 256, ephemeralStorageMiB: 512, reservedConcurrency: 0, requestsPerSecond: 10, burstLimit: 20, healthPath: "/health", authorization: "public_application_endpoint" };
  }
  const plan = { projectId: run.projectId, generationId, operationId, ownership: { organizationId: run.organizationId, bindingId: run.bindingId, bindingVersion: 1, accountId: run.accountId, region, environment: "staging" },
    repository: { sourceSha }, configurationFingerprint: scope.configurationFingerprint, selectedProfile: run.profile, profileInputs: configuration,
    assumptions: { stateful: false, continuousCompute: vm(run.profile), storageGiB: 1, monthlyRequests: 1000, monthlyTransferGiB: 1, monthlyLogGiB: 1 },
    services: [{ id: serviceId, port: vm(run.profile) ? 8080 : 3000, buildTarget: { status: "resolved", sourceSha, architecture: "amd64" } }], environmentReferences: [], dependencies: { database: null },
    infrastructure: { vpcId: run.network?.vpcId || "vpc-00000000", publicSubnetIds: run.network ? [run.network.subnetId] : [], terraformStateBucket: run.stateBucket }, status: "review_required", blockers: [] };
  return { scope, plan, configuration, assets };
}

async function session(run: Run, scope: any, purpose: "mutate" | "read") {
  const policy = purpose === "read" ? hostingProviderReadPolicy({ accountId: run.accountId, region, profile: run.profile }) : hostingProviderSessionPolicy({ ...scope, profile: run.profile });
  const encoded = JSON.stringify(policy);
  let policyArgs: string[];
  if (encoded.length <= 2048) policyArgs = ["--policy", encoded];
  else {
    // Production requires the operator-installed managed intersection policy at this exact path for oversized fences.
    const path = `/deployguard/${run.organizationId}/${run.projectId}/${run.profile}/`;
    // The ARN is deterministic, so a recovered run finds the policy even if its state file missed the write.
    const policyName = hostingPolicyName({ projectId: run.projectId, profile: run.profile, region }), arn = `arn:aws:iam::${run.accountId}:policy${path}${policyName}`;
    if (!run.policyArn && (await aws(["iam", "get-policy", "--policy-arn", arn], true)).error) run.policyArn = (await aws(["iam", "create-policy", "--policy-name", policyName, "--path", path, "--policy-document", encoded])).Policy.Arn;
    else {
      run.policyArn = arn;
      const versions = (await aws(["iam", "list-policy-versions", "--policy-arn", run.policyArn])).Versions || [];
      for (const version of versions.filter((item: any) => !item.IsDefaultVersion)) await aws(["iam", "delete-policy-version", "--policy-arn", run.policyArn, "--version-id", version.VersionId]);
      await aws(["iam", "create-policy-version", "--policy-arn", run.policyArn, "--policy-document", encoded, "--set-as-default"]);
    }
    await pause(10_000); policyArgs = ["--policy-arns", `arn=${run.policyArn}`];
  }
  if (!run.roleName) {
    const federated = await aws(["sts", "get-federation-token", "--name", `dg-verify-${run.runId}`, "--duration-seconds", "1190", ...policyArgs]);
    const c = federated.Credentials;
    return { accountId: run.accountId, region, expiresAt: new Date(c.Expiration).toISOString(), credentials: { accessKeyId: c.AccessKeyId, secretAccessKey: c.SecretAccessKey, sessionToken: c.SessionToken } };
  }
  const assumed = await aws(["sts", "assume-role", "--role-arn", `arn:aws:iam::${run.accountId}:role/${run.roleName}`, "--role-session-name", `dg-verify-${run.runId}-${purpose}`, "--duration-seconds", "1190", ...policyArgs]);
  const credentials = assumed.Credentials;
  return { accountId: run.accountId, region, expiresAt: new Date(credentials.Expiration).toISOString(), credentials: { accessKeyId: credentials.AccessKeyId, secretAccessKey: credentials.SecretAccessKey, sessionToken: credentials.SessionToken } };
}

const pluginCache = join(tmpdir(), "dg-verify-terraform-plugins");
const runCommand = async (file: string, args: string[], options: any) => {
  try {
    const { stdout } = await exec(file === "terraform" ? terraform : file, args, { ...options, env: { ...options.env, TF_PLUGIN_CACHE_DIR: pluginCache }, timeout: 30 * 60_000, maxBuffer: 64 * 1024 * 1024 });
    return stdout;
  } catch (error: any) { log(`${file} ${args[0]} failed: ${redact(String(error.stderr || error.stdout || error.message)).slice(-1500)}`); throw error; }
};

async function lifecycle(run: Run, save: () => Promise<void>, results: Record<string, string>) {
  await mkdir(pluginCache, { recursive: true });
  const builder = await loadHostingArtifacts(), runtime = await loadHostingRuntime(), evidence = await loadHostingEvidence();
  let route: string | null = null;
  const retained = new Map<string, any>();
  const authority = (artifacts: any) => {
    const m = artifacts.manifest; let current: any = null;
    return {
      assertCurrent: async () => ({ planFingerprint: m.scope.planFingerprint, artifactFingerprint: m.artifactFingerprint, bindingVersion: 1, approval: "approved", profileAvailable: true, pricingStatus: "complete" }),
      withCustomerSession: async (_request: any, callback: any) => { current = await session(run, { ...m.scope, ...(vm(run.profile) ? { dnsZoneId: m.dnsZoneId, dnsRecordName: new URL(m.runtimeIdentity.endpoint).hostname } : {}) }, "mutate"); try { return await callback(current); } finally { current = null; } },
      recordEvidence: async (event: any) => log(`evidence ${event.action}`),
      verifyRuntimeOwnership: async ({ identity }: any) => evidence.readProviderOwnership(m, identity, current),
      probeHealth: async ({ identity }: any) => evidence.probeProviderHealth(m, identity),
      promoteCompareAndSwap: async ({ identity }: any) => { retained.set(m.scope.generationId, { artifacts, identity, status: "verified", retainedUntil: new Date(Date.now() + 7 * 86400_000).toISOString() }); route = m.scope.generationId; return { status: "promoted", generationId: m.scope.generationId }; },
      getRetainedGeneration: async ({ generationId }: any) => retained.get(generationId),
      assertCleanup: async ({ identity }: any) => ({ status: "approved", generationActive: route === m.scope.generationId, rollbackRetained: false, resourceFingerprint: builder.fingerprint(identity) }),
    };
  };
  const deploy = async (index: number, failing = false) => {
    const generation = input(run, index, failing);
    generation.scope.planFingerprint = builder.fingerprint(generation.plan);
    const artifacts = builder.buildHostingArtifacts({ profile: run.profile, plan: generation.plan, configuration: generation.configuration, scope: generation.scope });
    const record = { generationId: generation.scope.generationId, artifacts, identity: null as any, assets: Object.fromEntries(Object.entries(generation.assets).map(([path, data]) => [path, data.toString("base64")])) };
    run.generations.push(record); await save();
    const started = Date.now();
    const result = await runtime.executeGeneration(artifacts, authority(artifacts), { runCommand, loadAsset: async ({ path }: any) => generation.assets[path] });
    record.identity = result.identity; await save();
    results[`deploy_${index}`] = `verified in ${Math.round((Date.now() - started) / 1000)}s; health ${result.proof.health.status} at ${result.identity.endpoint}`;
    log(results[`deploy_${index}`]);
    return record;
  };
  const first = await deploy(1);
  const read = await session(run, first.artifacts.manifest.scope, "read");
  const endpoint = await evidence.observeProviderEndpoint(first.artifacts.manifest, first.identity);
  results.monitoring_endpoint = `transport ${endpoint.transport}, application ${endpoint.application}, HTTP ${endpoint.httpStatus}`;
  try {
    const rows = await evidence.readProviderMetrics(first.artifacts.manifest, first.identity, read, { start: new Date(Date.now() - 3600_000), end: new Date() });
    results.monitoring_metrics = `read-only metric query succeeded; ${rows.length} datapoints (new resources may not have published yet)`;
  } catch (error) { results.monitoring_metrics = `FAILED: ${error instanceof Error ? redact(error.message) : "unknown"}`; }
  log(`${results.monitoring_endpoint}; ${results.monitoring_metrics}`);
  // Retry: an unhealthy candidate is rejected without moving the route, then a fresh attempt deploys and verifies.
  const rejectedStarted = Date.now(); let rejection = "";
  await deploy(3, true).then(() => { throw new Error("An unhealthy candidate generation was promoted."); }, (error) => { rejection = error instanceof Error ? redact(error.message) : "unknown"; });
  assert.equal(route, first.generationId, "A rejected candidate must not move the canonical route.");
  const stillLive = await evidence.observeProviderEndpoint(first.artifacts.manifest, first.identity);
  assert.equal(stillLive.application, "healthy", "The verified generation must keep serving after a rejected candidate.");
  results.retry_rejected = `unhealthy candidate rejected in ${Math.round((Date.now() - rejectedStarted) / 1000)}s (${rejection.slice(0, 160)}); route stayed on generation 1, HTTP ${stillLive.httpStatus}`;
  log(results.retry_rejected);
  // Remove the rejected candidate before retrying: it is never promoted, and small accounts cap concurrent instances.
  const rejected: any = run.generations.at(-1);
  await destroyGeneration(run, rejected, results); await save();
  assert(rejected.cleaned, "The rejected candidate must be removed before the retry.");
  results.retry_candidate_removed = "rejected candidate destroyed from its own state before the retry";
  const second = await deploy(2);
  results.retry = "fresh attempt deployed and verified after the rejected candidate";
  assert.equal(route, second.generationId);
  const rolled = await runtime.rollbackGeneration(first.artifacts.manifest.scope, first.generationId, authority(first.artifacts));
  assert.equal(route, first.generationId);
  results.rollback = `${rolled.status}; route returned to generation 1 after fresh ownership and health proof`;
  log(results.rollback);
  // A rollback-protected, still-active generation must be refused before any deletion.
  await assert.rejects(runtime.cleanupGeneration(first.artifacts, first.identity, authority(first.artifacts), { runCommand, loadAsset: async ({ path }: any) => Buffer.from(first.assets[path], "base64") }), /Cleanup requires/);
  results.cleanup_guard = "active generation cleanup refused";
  for (const record of [second, first]) {
    if (record === first) route = null; // decommission the project route before removing its last generation
    const started = Date.now();
    await runtime.cleanupGeneration(record.artifacts, record.identity, authority(record.artifacts), { runCommand, loadAsset: async ({ path }: any) => Buffer.from(record.assets[path], "base64") });
    results[`cleanup_${record === first ? 1 : 2}`] = `deleted through inspected destroy plan in ${Math.round((Date.now() - started) / 1000)}s`;
    log(results[`cleanup_${record === first ? 1 : 2}`]);
    (record as any).cleaned = true; await save();
  }
}

// Emergency path for anything the lifecycle left behind: destroy each uncleaned generation from its own state.
async function teardown(run: Run, results: Record<string, string>) {
  for (const record of run.generations.filter((item: any) => !item.cleaned)) await destroyGeneration(run, record, results);
  if (run.generations.some((item: any) => !item.cleaned)) { results.scaffolding = "LEFTOVER: state bucket and role kept because generations remain; rerun with --recover"; return; }
  const versions = await aws(["s3api", "list-object-versions", "--bucket", run.stateBucket], true);
  const objects = [...(versions.Versions || []), ...(versions.DeleteMarkers || [])].map((item: any) => ({ Key: item.Key, VersionId: item.VersionId }));
  if (objects.length) await aws(["s3api", "delete-objects", "--bucket", run.stateBucket, "--delete", JSON.stringify({ Objects: objects, Quiet: true })]);
  await aws(["s3api", "delete-bucket", "--bucket", run.stateBucket], true);
  if (run.roleName) {
    await aws(["iam", "delete-role-policy", "--role-name", run.roleName, "--policy-name", "verification-ceiling"], true);
    await aws(["iam", "delete-role", "--role-name", run.roleName], true);
  }
  if (run.policyArn) {
    for (const version of ((await aws(["iam", "list-policy-versions", "--policy-arn", run.policyArn], true)).Versions || []).filter((item: any) => !item.IsDefaultVersion)) await aws(["iam", "delete-policy-version", "--policy-arn", run.policyArn, "--version-id", version.VersionId], true);
    await aws(["iam", "delete-policy", "--policy-arn", run.policyArn], true);
  }
}

// Destroys one generation from its own Terraform state (used for failed candidates and emergency teardown).
async function destroyGeneration(run: Run, record: any, results: Record<string, string>) {
  log(`emergency destroy of generation ${record.generationId}`);
    if (run.profile === "ec2") {
      // Keep bootstrap evidence from a failed candidate before it is destroyed (no SSH is ever opened).
      const found = await aws(["ec2", "describe-instances", "--filters", `Name=tag:GenerationId,Values=${record.generationId}`], true);
      const instanceId = found.Reservations?.[0]?.Instances?.[0]?.InstanceId;
      if (instanceId) {
        const consoleOutput = await aws(["ec2", "get-console-output", "--instance-id", instanceId, "--latest"], true);
        const text = typeof consoleOutput.Output === "string" ? consoleOutput.Output : ""; // The AWS CLI already decodes console output.
        await writeFile(join(flag("state-dir") || tmpdir(), `dg-live-${run.runId}-${record.generationId.slice(0, 8)}-console.log`), redact(text.split("\n").slice(-200).join("\n")), { mode: 0o600 });
      }
    }
    const dir = await mkdtemp(join(tmpdir(), "dg-verify-destroy-"));
    try {
      const m = record.artifacts.manifest;
      for (const [name, data] of Object.entries(record.artifacts.files)) await writeFile(join(dir, name), data as string);
      for (const [path, data] of Object.entries(record.assets)) { await mkdir(join(dir, "assets"), { recursive: true }); await writeFile(join(dir, "assets", path), Buffer.from(data as string, "base64")); }
      const lock = await readFile(resolve(__dirname, "../../infrastructure/railpack-runtime/.terraform.lock.hcl"), "utf8");
      await writeFile(join(dir, ".terraform.lock.hcl"), lock.match(/provider "registry\.terraform\.io\/hashicorp\/aws" \{[\s\S]*?\n\}/)![0].replace('constraints = "~> 5.0"', 'constraints = "5.100.0"') + "\n");
      const bucket = `dg-${run.projectId.replaceAll("-", "").slice(0, 12)}-${record.generationId.replaceAll("-", "").slice(0, 12)}-${run.accountId}`;
      if (!vm(run.profile)) {
        const versions = await aws(["s3api", "list-object-versions", "--bucket", bucket], true);
        const objects = [...(versions.Versions || []), ...(versions.DeleteMarkers || [])].map((item: any) => ({ Key: item.Key, VersionId: item.VersionId }));
        if (objects.length) await aws(["s3api", "delete-objects", "--bucket", bucket, "--delete", JSON.stringify({ Objects: objects, Quiet: true })]);
      }
      const credentials = await session(run, { ...m.scope, ...(vm(run.profile) ? { dnsZoneId: m.dnsZoneId, dnsRecordName: new URL(m.runtimeIdentity.endpoint).hostname } : {}) }, "mutate");
      const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("AWS_"))), AWS_ACCESS_KEY_ID: credentials.credentials.accessKeyId, AWS_SECRET_ACCESS_KEY: credentials.credentials.secretAccessKey, AWS_SESSION_TOKEN: credentials.credentials.sessionToken, AWS_REGION: region, TF_PLUGIN_CACHE_DIR: pluginCache };
      await runCommand("terraform", ["init", "-input=false", "-reconfigure", "-lockfile=readonly", `-backend-config=bucket=${m.backend.bucket}`, `-backend-config=key=${m.stateKey}`, `-backend-config=region=${region}`, "-backend-config=encrypt=true"], { cwd: dir, env });
      await runCommand("terraform", ["destroy", "-auto-approve", "-input=false"], { cwd: dir, env });
      (record as any).cleaned = true; results[`emergency_${record.generationId.slice(0, 8)}`] = "destroyed from state";
    } catch (error) { results[`emergency_${record.generationId.slice(0, 8)}`] = `LEFTOVER: emergency destroy failed (${error instanceof Error ? redact(error.message).slice(0, 300) : "unknown"})`; }
    finally { await rm(dir, { recursive: true, force: true }); }
}

// Independent proof using the operator identity, not Terraform's own view.
async function verifyRemoval(run: Run, results: Record<string, string>) {
  const gone = async (label: string, args: string[], pattern: RegExp) => {
    const response = await aws(args, true);
    results[`removed_${label}`] = response.error && pattern.test(response.error) ? "confirmed absent" : `LEFTOVER: ${response.error ? response.error.slice(0, 200) : "still present"}`;
  };
  for (const record of run.generations) {
    const short = record.generationId.slice(0, 8), name = `dg-${run.projectId.replaceAll("-", "").slice(0, 12)}-${record.generationId.replaceAll("-", "").slice(0, 12)}`;
    if (!vm(run.profile)) await gone(`bucket_${short}`, ["s3api", "head-bucket", "--bucket", `${name}-${run.accountId}`], /404|Not Found|NoSuchBucket/);
    if (run.profile === "ec2" && record.identity?.instanceId) {
      const state = await aws(["ec2", "describe-instances", "--instance-ids", record.identity.instanceId], true);
      const status = state.Reservations?.[0]?.Instances?.[0]?.State?.Name;
      results[`removed_instance_${short}`] = state.error || status === "terminated" ? "confirmed terminated" : `LEFTOVER: instance ${status}`;
      await gone(`elastic_ip_${short}`, ["ec2", "describe-addresses", "--allocation-ids", record.identity.elasticIpAllocationId], /InvalidAllocationID.NotFound/);
      await gone(`instance_profile_${short}`, ["iam", "get-instance-profile", "--instance-profile-name", name], /NoSuchEntity/);
      await gone(`iam_role_${short}`, ["iam", "get-role", "--role-name", name], /NoSuchEntity/);
      const groups = await aws(["ec2", "describe-security-groups", "--filters", `Name=group-name,Values=${name}`]);
      results[`removed_security_group_${short}`] = groups.SecurityGroups?.length ? "LEFTOVER: security group present" : "confirmed absent";
    }
    if (run.profile === "lightsail") {
      await gone(`lightsail_instance_${short}`, ["lightsail", "get-instance", "--instance-name", name], /NotFound|DoesNotExist/);
      await gone(`lightsail_static_ip_${short}`, ["lightsail", "get-static-ip", "--static-ip-name", `${name}-ip`], /NotFound|DoesNotExist/);
    }
    if (vm(run.profile)) {
      const host = `g-${record.generationId.replaceAll("-", "").slice(0, 12)}.${dnsZone.name}.`;
      const records = await aws(["route53", "list-resource-record-sets", "--hosted-zone-id", dnsZone.id, "--start-record-name", host, "--max-items", "1"]);
      results[`removed_dns_${short}`] = records.ResourceRecordSets?.[0]?.Name === host ? "LEFTOVER: generation DNS record present" : "confirmed absent";
    }
    if (run.profile === "static" && record.identity?.distributionId) await gone(`cloudfront_${short}`, ["cloudfront", "get-distribution", "--id", record.identity.distributionId], /NoSuchDistribution/);
    if (run.profile === "lambda") {
      await gone(`lambda_${short}`, ["lambda", "get-function", "--function-name", name], /ResourceNotFound/);
      await gone(`iam_role_${short}`, ["iam", "get-role", "--role-name", name], /NoSuchEntity/);
      if (record.identity?.apiId) await gone(`http_api_${short}`, ["apigatewayv2", "get-api", "--api-id", record.identity.apiId], /NotFound/);
      const groups = await aws(["logs", "describe-log-groups", "--log-group-name-prefix", `/aws/lambda/${name}`]);
      results[`removed_logs_${short}`] = groups.logGroups?.length ? "LEFTOVER: log group present" : "confirmed absent";
    }
  }
  const tagged = await aws(["resourcegroupstaggingapi", "get-resources", "--tag-filters", `Key=ProjectId,Values=${run.projectId}`]);
  // The tagging index lags EC2 deletions; confirm EC2 ARNs directly before calling them leftovers.
  const lingering: string[] = [];
  for (const arn of (tagged.ResourceTagMappingList || []).map((item: any) => item.ResourceARN as string)) {
    const [, kind, id] = arn.match(/:ec2:[^:]*:\d+:(instance|volume|security-group|security-group-rule)\/(.+)$/) || [];
    if (!kind) { lingering.push(arn); continue; }
    const probe = kind === "instance" ? ["ec2", "describe-instances", "--instance-ids", id, "--query", "Reservations[].Instances[].State.Name"] : kind === "volume" ? ["ec2", "describe-volumes", "--volume-ids", id] : kind === "security-group" ? ["ec2", "describe-security-groups", "--group-ids", id] : ["ec2", "describe-security-group-rules", "--security-group-rule-ids", id];
    try { const found = await aws(probe); if (!(kind === "instance" && JSON.stringify(found).includes("terminated"))) lingering.push(arn); }
    catch (error: any) { if (!/NotFound/.test(String(error?.message || error))) lingering.push(arn); }
  }
  results.removed_tagged_resources = lingering.length ? `LEFTOVER: ${lingering.join(", ")}` : "none remain with the test ProjectId tag (EC2 entries confirmed terminated or absent)";
  await gone("state_bucket", ["s3api", "head-bucket", "--bucket", run.stateBucket], /404|Not Found|NoSuchBucket/);
  if (run.roleName) await gone("verification_role", ["iam", "get-role", "--role-name", run.roleName], /NoSuchEntity/);
  if (run.policyArn) await gone("managed_policy", ["iam", "get-policy", "--policy-arn", run.policyArn], /NoSuchEntity/);
}

void main().catch((error) => { console.error(redact(String(error?.stack || error))); process.exit(1); });
