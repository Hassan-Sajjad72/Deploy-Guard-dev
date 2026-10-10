import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, chmodSync, statSync, symlinkSync, unlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { captureDeletionManifest, observeDeletion, validateDeletionManifest } from "../../infrastructure/railpack-runtime/observe-deletion.mjs";
import { retainDeletionManifest, restoreDeletionManifest } from "../../infrastructure/railpack-runtime/retain-deletion-manifest.mjs";

const scope = {
  projectId: "11111111-1111-4111-8111-111111111111", operationId: "22222222-2222-4222-8222-222222222222",
  generationIds: ["33333333-3333-4333-8333-333333333333"], environmentName: "dev", region: "us-east-1", accountId: "123456789012",
};
const retryScope = { ...scope, operationId: "44444444-4444-4444-8444-444444444444" };
const historicalGeneration = "55555555-5555-4555-8555-555555555555";
const arn = (name) => `arn:aws:ecs:${scope.region}:${scope.accountId}:${name}`;
const cluster = arn("cluster/dg-111111111111");
const bootstrap = [
  { type: "aws_ecs_cluster", id: cluster },
  { type: "aws_ecs_service", id: arn("service/dg-111111111111/app"), parent: cluster },
  { type: "aws_ecs_task_definition", id: arn("task-definition/app:1") },
  { type: "aws_security_group", id: "sg-123abc" },
];
const manifest = (resources, selectedScope = scope) => ({ contractVersion: "deployguard.aws-deletion-manifest/v1", scope: selectedScope, resources });
const state = (resources) => ({ values: { root_module: { resources: resources.map((r) => ({
  mode: "managed", type: r.type, values: { id: r.id, arn: r.id, ...(r.parent ? { cluster: r.parent } : {}),
    tags: { ManagedBy: "DeployGuard", DeployGuardProjectId: scope.projectId } },
})) } } });
const before = captureDeletionManifest(state(bootstrap), scope);
const partial = captureDeletionManifest(state(bootstrap.slice(-1)), retryScope);
assert.equal(partial.resources.length, 1, "partial Terraform state alone loses three previously owned resources");
assert.throws(() => captureDeletionManifest({ values: { root_module: {} } }, retryScope), /DG_DELETION_SCOPE_INVALID/);
assert.throws(() => validateDeletionManifest({ ...before, rawState: { secret_string: "DO-NOT-RETAIN" } }), /DG_DELETION_SCOPE_INVALID/);

const temp = mkdtempSync(join(tmpdir(), "deployguard-retention-"));
const directory = join(temp, "owned-evidence");
const cli = new URL("../../infrastructure/railpack-runtime/retain-deletion-manifest.mjs", import.meta.url).pathname;
const exec = promisify(execFile);
const cliCall = (...args) => exec(process.execPath, [cli, ...args], { timeout: 10000, env: { PATH: process.env.PATH } });
try {
  const original = structuredClone(before);
  const first = retainDeletionManifest(directory, before);
  const repeated = retainDeletionManifest(directory, { ...before, resources: [...before.resources].reverse() });
  assert.deepEqual(first, repeated, "retry/reordered identifiers must reuse one immutable snapshot");
  assert.deepEqual(before, original, "capture/retention cannot mutate caller evidence");
  assert.match(first.manifestSha256, /^[a-f0-9]{64}$/);
  assert.equal(readdirSync(directory).length, 1);
  assert.equal(statSync(directory).mode & 0o777, 0o700);
  assert.equal(statSync(join(directory, `${first.manifestSha256}.json`)).mode & 0o777, 0o400);

  const second = retainDeletionManifest(directory, partial);
  // The caller supplies exact pre-existing provenance; these are synthetic
  // fixtures, not automatic discovery or certification of historical completeness.
  const external = manifest([
    { type: "aws_ecs_task_definition", id: arn("task-definition/app:7") },
    { type: "aws_ecs_task_definition", id: arn("task-definition/app:6") },
    { type: "aws_secretsmanager_secret", id: `arn:aws:secretsmanager:${scope.region}:${scope.accountId}:secret:deployguard/${scope.projectId}/dev/services/runtime-abcdef` },
    { type: "aws_ecr_repository", id: `deployguard-${scope.projectId}` },
    { type: "s3_state_object", id: `projects/${scope.projectId}/dev/runtime/terraform.tfstate`, parent: "shared-state-bucket" },
    { type: "s3_state_object", id: `projects/${scope.projectId}/dev/runtime/terraform.tfstate.tflock`, parent: "shared-state-bucket" },
  ], { ...scope, generationIds: [historicalGeneration] });
  const third = retainDeletionManifest(directory, external);
  const receipts = [first, second, third];
  const completeScope = { ...retryScope, generationIds: [...scope.generationIds, historicalGeneration] };
  const restored = restoreDeletionManifest(directory, completeScope, receipts);
  assert.equal(restored.resources.length, 10, "union preserves topology, historical/direct revisions, secrets, ECR, state and lock");
  assert.deepEqual(restored.scope, { ...completeScope, generationIds: [...completeScope.generationIds].sort() });
  for (const resource of [...bootstrap, ...external.resources]) assert.ok(restored.resources.some((r) => JSON.stringify(r) === JSON.stringify(resource)));
  assert.deepEqual(restoreDeletionManifest(directory, completeScope, [...receipts].reverse()), restored, "receipt order cannot select authority");
  assert.doesNotMatch(readFileSync(join(directory, `${first.manifestSha256}.json`), "utf8"), /tags|secret_string|container_definitions|DO-NOT-RETAIN/);

  // An interrupted writer cannot publish truncated bytes as a trusted snapshot.
  writeFileSync(join(directory, ".pending-fixture-interruption"), "{truncated");
  assert.deepEqual(restoreDeletionManifest(directory, completeScope, receipts), restored);
  let checked = 0;
  const result = await observeDeletion(restored, async (args) => {
    if (args[0] === "sts") return { status: 0, stdout: JSON.stringify({ Account: scope.accountId }) };
    checked++;
    if (args[1] === "describe-clusters") return { status: 0, stdout: JSON.stringify({ clusters: [], failures: [{ arn: cluster, reason: "MISSING" }] }) };
    if (args[1] === "describe-services") return { status: 254, stderr: "An error occurred (ClusterNotFoundException) when calling the DescribeServices operation:" };
    if (args[1] === "describe-task-definition") return { status: 0, stdout: JSON.stringify({ taskDefinition: { taskDefinitionArn: args[3], status: "INACTIVE" } }) };
    const code = { "describe-security-groups": "InvalidGroup.NotFound", "describe-secret": "ResourceNotFoundException", "describe-repositories": "RepositoryNotFoundException", "head-object": "404" }[args[1]];
    assert.ok(code, "only exact restored resource read commands allowed");
    return { status: 254, stderr: `An error occurred (${code}) when calling the DescribeResource operation:` };
  }, { delayMs: 0 });
  assert.equal(result.status, "PASS");
  assert.equal(checked, restored.resources.length, "partial retry must still observe every retained resource");

  for (const changed of [
    { projectId: "99999999-9999-4999-8999-999999999999" }, { environmentName: "prod" }, { accountId: "999999999999" },
    { region: "us-west-2" }, { generationIds: scope.generationIds },
    { generationIds: [...completeScope.generationIds, "66666666-6666-4666-8666-666666666666"] },
  ]) assert.throws(() => restoreDeletionManifest(directory, { ...completeScope, ...changed }, receipts), /DG_DELETION_RETENTION_SCOPE_MISMATCH/);
  for (const bad of [[], [...receipts, first], [{ ...first, secret: "DO-NOT-RETAIN" }], [{ ...first, manifestSha256: "../other" }]]) {
    assert.throws(() => restoreDeletionManifest(directory, completeScope, bad), /DG_DELETION_RETENTION_INVALID/);
  }
  const conflict = retainDeletionManifest(directory, manifest([{ ...bootstrap[1], parent: arn("cluster/other") }]));
  assert.throws(() => restoreDeletionManifest(directory, completeScope, [...receipts, conflict]), /DG_DELETION_RETENTION_SCOPE_MISMATCH/);
  assert.throws(() => retainDeletionManifest(directory, { ...before, resources: [] }), /DG_DELETION_SCOPE_INVALID/);
  const maximum = retainDeletionManifest(directory, manifest(Array.from({ length: 1000 }, (_, index) => ({ type: "aws_security_group", id: `sg-fixture-${index}` }))));
  assert.throws(() => restoreDeletionManifest(directory, retryScope, [maximum, first]), /DG_DELETION_SCOPE_INVALID/, "cross-snapshot union must preserve the observer resource ceiling");

  // Exercise the usable transport CLI and concurrent idempotent publication.
  const input = join(temp, "manifest.json");
  writeFileSync(input, JSON.stringify(before));
  const concurrentDirectory = join(temp, "concurrent-evidence");
  const published = await Promise.all(Array.from({ length: 3 }, () => cliCall("--retain", input, "--directory", concurrentDirectory)));
  for (const output of published) assert.deepEqual(JSON.parse(output.stdout), first);
  assert.equal(readdirSync(concurrentDirectory).length, 1, "concurrent first publication must leave exactly one complete object and no pending files");
  assert.deepEqual(restoreDeletionManifest(concurrentDirectory, retryScope, [first]).resources, restored.resources.filter((r) => bootstrap.some((b) => b.id === r.id)));
  chmodSync(concurrentDirectory, 0o755);
  assert.throws(() => restoreDeletionManifest(concurrentDirectory, retryScope, [first]), /DG_DELETION_RETENTION_INVALID/, "shared-readable stores are not an accepted retention boundary");
  chmodSync(concurrentDirectory, 0o700);
  const request = join(temp, "restore.json");
  writeFileSync(request, JSON.stringify({ scope: completeScope, receipts }));
  assert.deepEqual(JSON.parse((await cliCall("--restore", request, "--directory", directory)).stdout), restored);
  writeFileSync(input, "{malformed-DO-NOT-RETAIN");
  await assert.rejects(cliCall("--retain", input, "--directory", directory), (error) => {
    assert.equal(error.stderr, "DG_DELETION_RETENTION_INVALID\n");
    assert.doesNotMatch(error.stderr, /DO-NOT-RETAIN/);
    return true;
  });

  // Missing/corrupt trusted objects fail closed, never shrink to current state.
  const firstPath = join(directory, `${first.manifestSha256}.json`);
  chmodSync(firstPath, 0o600);
  writeFileSync(firstPath, JSON.stringify(partial));
  assert.throws(() => restoreDeletionManifest(directory, completeScope, receipts), /DG_DELETION_RETENTION_INTEGRITY_FAILED/);
  assert.throws(() => retainDeletionManifest(directory, before), /DG_DELETION_RETENTION_INTEGRITY_FAILED/, "a corrupt same-name object cannot be silently overwritten");
  unlinkSync(firstPath);
  assert.throws(() => restoreDeletionManifest(directory, completeScope, receipts), { code: "ENOENT" });
  symlinkSync(input, firstPath);
  assert.throws(() => restoreDeletionManifest(directory, completeScope, receipts), { code: "ELOOP" });
  const alias = join(temp, "alias");
  symlinkSync(directory, alias);
  assert.throws(() => retainDeletionManifest(alias, before), /DG_DELETION_RETENTION_INVALID/);
} finally {
  // Exact test-owned temporary directory; no user data or AWS cleanup involved.
  rmSync(temp, { recursive: true, force: true });
}
console.log("DELETION_MANIFEST_RETENTION=PASS LOCAL_FILES_ONLY=1 PARTIAL_RETRY_UNION=1 IMMUTABLE_HASH_RECEIPTS=1 MISSING_OR_CORRUPT_FAIL_CLOSED=1 MOCKED_OBSERVER_HANDOFF=1");
