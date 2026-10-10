import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { cleanupRetainedRuntime, retainedDestroyOwnership, validateRetainedTerraformState } from "../../infrastructure/railpack-runtime/destroy-retained-runtime.mjs";

const projectId = "11111111-1111-4111-8111-111111111111";
const operationId = "22222222-2222-4222-8222-222222222222";
const generationId = "33333333-3333-4333-8333-333333333333";
const scope = { projectId, operationId, environmentName: "dev", accountId: "123456789012", region: "us-east-1", generationIds: [generationId] };
const key = `projects/${projectId}/dev/runtime/terraform.tfstate`;
const cluster = `arn:aws:ecs:us-east-1:123456789012:cluster/deployguard-${projectId}`;
const definition = `arn:aws:ecs:us-east-1:123456789012:task-definition/deployguard-${projectId}:7`;
const secret = `arn:aws:secretsmanager:us-east-1:123456789012:secret:deployguard/${projectId}/dev/services/${generationId}/runtime-abcdef`;
const repository = `deployguard-${projectId}`;
const manifest = { contractVersion: "deployguard.aws-deletion-manifest/v1", scope, resources: [
  { type: "aws_ecs_cluster", id: cluster }, { type: "aws_ecs_task_definition", id: definition },
  { type: "aws_secretsmanager_secret", id: secret }, { type: "aws_ecr_repository", id: repository },
  ...[key, `${key}.tflock`].map((id) => ({ type: "s3_state_object", id, parent: "m0-disposable-state" })) ] };
const runtime = { schemaVersion: 3, projectId, operationId, environmentName: "dev", sourceSha: "a".repeat(40),
  projectDeletion: { generationIds: [generationId], ownership: { contractVersion: "deployguard.destroy-ownership/v1", manifest,
    receipts: [{ operationId: generationId, sha256: "b".repeat(64) }] } } };
const success = (body) => ({ status: 0, stdout: JSON.stringify(body), stderr: "" });
const error = (code) => ({ status: 1, stdout: "", stderr: `An error occurred (${code}) when calling the DescribeResource operation: fixture` });
function fakeProvider({ denied = false, residue = false, lock = false, wrongAccount = false, writeDenied = false, foreignSecretTag = false } = {}) {
  const calls = []; const removed = new Set();
  const run = async (args) => {
    calls.push(args);
    if (args[0] === "sts") return success({ Account: wrongAccount ? "999999999999" : scope.accountId });
    const id = args.includes("--key") ? args[args.indexOf("--key") + 1]
      : [cluster, definition, secret, repository].find((value) => args.includes(value));
    assert.ok(id, "every provider call must use an exact frozen resource, never tags/discovery");
    if (/^(delete-|deregister-)/.test(args[1])) {
      if (writeDenied) return error("AccessDeniedException");
      assert.notEqual(id, `${key}.tflock`, "cleanup must never force-unlock an unproven current writer");
      removed.add(id); return success({});
    }
    if (denied) return error("AccessDeniedException");
    if (id === cluster) return success({ clusters: [], failures: [{ arn: cluster, reason: "MISSING" }] });
    const absent = removed.has(id) && !residue;
    if (id === definition) return success({ taskDefinition: { taskDefinitionArn: id, status: absent ? "INACTIVE" : "ACTIVE" } });
    if (id === secret) return absent ? error("ResourceNotFoundException") : success({ ARN: id,
      Name: `deployguard/${projectId}/dev/services/${generationId}/runtime`, Tags: Object.entries({ ManagedBy: "DeployGuard",
        DeployGuardProjectId: projectId, Environment: foreignSecretTag ? "prod" : "dev", SecretPurpose: "application_runtime",
        DeployGuardScope: "service", DeployGuardServiceId: generationId }).map(([Key, Value]) => ({ Key, Value })) });
    if (id === repository) return absent ? error("RepositoryNotFoundException") : success({ repositories: [{ repositoryName: id }] });
    if (id === `${key}.tflock`) return lock ? success({ ContentLength: 1 }) : error("404");
    return absent ? error("404") : success({ ContentLength: 1 });
  };
  return { run, calls, removed };
}
const provider = fakeProvider();
const result = await cleanupRetainedRuntime(runtime, provider.run, { attempts: 1, delayMs: 0 });
assert.equal(result.destroyVerification.contractVersion, "deployguard.destroy-result/v3");
assert.equal(result.destroyVerification.observation.status, "PASS");
assert.equal(result.destroyVerification.observation.observations.length, manifest.resources.length);
assert.equal(result.destroyVerification.observation.manifestSha256, createHash("sha256").update(JSON.stringify(manifest)).digest("hex"));
assert.deepEqual([...provider.removed].sort(), [definition, secret, repository, key].sort());
assert.deepEqual(runtime.projectDeletion.ownership.manifest, manifest, "cleanup cannot narrow retained authority");
const mutable = structuredClone(runtime);
const mutationProvider = fakeProvider();
let mutated = false;
const mutationResult = await cleanupRetainedRuntime(mutable, async (args) => {
  if (!mutated) {
    mutated = true; mutable.projectId = generationId; mutable.sourceSha = "f".repeat(40);
    mutable.projectDeletion.ownership.manifest.resources = [];
  }
  return mutationProvider.run(args);
}, { attempts: 1, delayMs: 0 });
assert.equal(mutationResult.sourceSha, runtime.sourceSha, "caller mutation during provider awaits cannot change frozen result identity");
assert.equal(mutationResult.destroyVerification.projectId, projectId);
assert.deepEqual(mutationResult.destroyVerification.observation.scope, scope);
for (const options of [{ denied: true }, { wrongAccount: true }, { writeDenied: true }, { residue: true }, { lock: true }, { foreignSecretTag: true }]) {
  const failed = fakeProvider(options);
  await assert.rejects(() => cleanupRetainedRuntime(runtime, failed.run, { attempts: 1, delayMs: 0 }), /DG_DESTROY_OWNERSHIP_INCOMPLETE/);
  if (options.denied || options.wrongAccount || options.foreignSecretTag) assert.equal(failed.removed.size, 0, "unverified reads/account or contradictory secret tags must block provider writes");
}
const state = { values: { root_module: { resources: [{ mode: "managed", type: "aws_ecs_cluster",
  values: { id: cluster, arn: cluster, tags: { ManagedBy: "DeployGuard", DeployGuardProjectId: projectId } } }] } } };
assert.doesNotThrow(() => validateRetainedTerraformState(runtime, state));
assert.doesNotThrow(() => validateRetainedTerraformState(runtime, { format_version: "1.0" }), "empty state on retry does not erase retained IDs");
const uncovered = structuredClone(state); uncovered.values.root_module.resources[0].values.id += "-late"; uncovered.values.root_module.resources[0].values.arn += "-late";
assert.throws(() => validateRetainedTerraformState(runtime, uncovered), /DG_DESTROY_OWNERSHIP_INCOMPLETE/);
const databaseSecret = `arn:aws:secretsmanager:us-east-1:123456789012:secret:deployguard/${projectId}/dev/database-abcdef`;
const protectedRuntime = structuredClone(runtime);
protectedRuntime.projectDeletion.ownership.manifest.resources.push({ type: "aws_secretsmanager_secret", id: databaseSecret });
const protectedProvider = fakeProvider();
let protectedWrites = 0;
await assert.rejects(() => cleanupRetainedRuntime(protectedRuntime, async (args) => {
  if (args.includes(databaseSecret)) {
    if (args[1] !== "describe-secret") protectedWrites++;
    return success({ ARN: databaseSecret, Name: `deployguard/${projectId}/dev/database`, DeletionDate: "2099-01-01T00:00:00Z" });
  }
  return protectedProvider.run(args);
}, { attempts: 1, delayMs: 0 }), /DG_DESTROY_OWNERSHIP_INCOMPLETE/);
assert.equal(protectedWrites, 0, "pending database-secret recovery must block proof without shortening its protection");
for (const mutate of [
  (row) => { row.projectDeletion.ownership = undefined; },
  (row) => { row.projectDeletion.ownership.receipts = []; },
  (row) => { row.projectDeletion.ownership.receipts.push(row.projectDeletion.ownership.receipts[0]); },
  (row) => { row.environmentName = "prod"; },
  (row) => { row.projectDeletion.ownership.manifest.resources[3].id = "shared-unrelated"; },
  (row) => { row.projectDeletion.ownership.manifest.resources[2].id = secret.replace("/dev/", "/prod/"); },
  (row) => { row.projectDeletion.ownership.manifest.resources.pop(); },
]) {
  const invalid = structuredClone(runtime); mutate(invalid);
  assert.throws(() => retainedDestroyOwnership(invalid));
  let calls = 0;
  await assert.rejects(() => cleanupRetainedRuntime(invalid, async () => { calls++; return success({}); }));
  assert.equal(calls, 0, "invalid/missing/foreign retained authority must fail before any provider call");
}
console.log("STRICT_DESTROY_PRODUCER=PASS EXACT_FROZEN_IDS=1 INDEPENDENT_OBSERVATION=1 DENIAL_RESIDUE_LOCK_REJECTED=1 SHARED_WRITES=0 AWS_EXECUTION=NONE");
