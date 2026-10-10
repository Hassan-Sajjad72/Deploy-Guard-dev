import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { captureDeletionManifest, observeDeletion, validateDeletionManifest } from "../../infrastructure/railpack-runtime/observe-deletion.mjs";

const scope = {
  projectId: "11111111-1111-4111-8111-111111111111", operationId: "22222222-2222-4222-8222-222222222222",
  generationIds: ["33333333-3333-4333-8333-333333333333"], environmentName: "dev", region: "us-east-1", accountId: "123456789012",
};
const arn = (service, name) => `arn:aws:${service}:us-east-1:${scope.accountId}:${name}`;
const cluster = arn("ecs", "cluster/dg-111111111111");
const role = "dg-111111111111-execution";
const resources = [
  ["aws_ecs_cluster", cluster, "ClusterNotFoundException"],
  ["aws_ecs_service", arn("ecs", "service/dg-111111111111/app"), "ClusterNotFoundException", cluster],
  ["aws_ecs_task_definition", arn("ecs", "task-definition/app:3"), null],
  ["aws_security_group", "sg-123abc", "InvalidGroup.NotFound"],
  ["aws_lb", arn("elasticloadbalancing", "loadbalancer/app/test/123"), "LoadBalancerNotFound"],
  ["aws_lb_listener", arn("elasticloadbalancing", "listener/app/test/123/456"), "ListenerNotFound"],
  ["aws_lb_target_group", arn("elasticloadbalancing", "targetgroup/test/123"), "TargetGroupNotFound"],
  ["aws_efs_file_system", "fs-123abc", "FileSystemNotFound"],
  ["aws_efs_access_point", "fsap-123abc", "AccessPointNotFound"],
  ["aws_efs_mount_target", "fsmt-123abc", "MountTargetNotFound"],
  ["aws_secretsmanager_secret", arn("secretsmanager", `secret:deployguard/${scope.projectId}/dev/database-abcdef`), "ResourceNotFoundException"],
  ["aws_iam_role", role, "NoSuchEntity"],
  ["aws_service_discovery_service", "srv-123abc", "ServiceNotFound"],
  ["aws_service_discovery_private_dns_namespace", "ns-123abc", "NamespaceNotFound"],
  ["aws_cloudwatch_log_group", `/deployguard/${scope.projectId}/services/app`, null],
  ["aws_ecr_repository", `deployguard-${scope.projectId}`, "RepositoryNotFoundException"],
  ["s3_state_object", `projects/${scope.projectId}/dev/runtime/terraform.tfstate`, "404", "shared-state-bucket"],
  ["s3_state_object", `projects/${scope.projectId}/dev/runtime/terraform.tfstate.tflock`, "404", "shared-state-bucket"],
];
const manifest = { contractVersion: "deployguard.aws-deletion-manifest/v1", scope, resources: resources.map(([type, id, , parent]) => ({ type, id, ...(parent ? { parent } : {}) })) };
const error = (code) => ({ status: 254, stdout: "", stderr: `An error occurred (${code}) when calling the DescribeResource operation: test fixture` });
const success = (body) => ({ status: 0, stdout: JSON.stringify(body), stderr: "" });
const indexOfResource = (args) => manifest.resources.findIndex((r) => args.includes(r.id));
const absent = (args) => {
  if (args[0] === "sts") return success({ Account: scope.accountId });
  const index = indexOfResource(args);
  assert.ok(index >= 0, "only exact manifest IDs may be observed");
  const r = manifest.resources[index];
  if (args[1] === "describe-services") return success({ services: [], failures: [{ arn: args[args.indexOf("--services") + 1], reason: "MISSING" }] });
  if (r.type === "aws_ecs_cluster") return success({ clusters: [], failures: [{ arn: r.id, reason: "MISSING" }] });
  if (r.type === "aws_ecs_task_definition") return success({ taskDefinition: { taskDefinitionArn: r.id, status: "INACTIVE" } });
  if (r.type === "aws_cloudwatch_log_group") return success({ logGroups: [{ logGroupName: `${r.id}-other` }] });
  return error(resources[index][2]);
};
const calls = [];
const report = await observeDeletion(manifest, async (args) => { calls.push(args); return absent(args); }, { delayMs: 0 });
assert.equal(report.status, "PASS");
assert.equal(report.observations.length, 18, "every exact resource and both state/lock keys must be checked");
assert.match(report.manifestSha256, /^[0-9a-f]{64}$/);
assert.deepEqual(report.scope, scope);
assert.ok(calls.every((args) => /^(get-|describe-|head-)/.test(args[1])), "observer must never call a write, discovery inventory, or delete API");
assert.ok(calls.every((args) => args.includes(scope.region)));

const present = [
  { clusters: [{ clusterArn: resources[0][1], status: "ACTIVE" }], failures: [] },
  { services: [{ serviceArn: resources[1][1], status: "DRAINING", runningCount: 1, pendingCount: 0 }], failures: [] },
  { taskDefinition: { taskDefinitionArn: resources[2][1], status: "ACTIVE" } },
  { SecurityGroups: [{ GroupId: resources[3][1] }] },
  { LoadBalancers: [{ LoadBalancerArn: resources[4][1] }] },
  { Listeners: [{ ListenerArn: resources[5][1] }] },
  { TargetGroups: [{ TargetGroupArn: resources[6][1] }] },
  { FileSystems: [{ FileSystemId: resources[7][1] }] },
  { AccessPoints: [{ AccessPointId: resources[8][1] }] },
  { MountTargets: [{ MountTargetId: resources[9][1] }] },
  { ARN: resources[10][1] }, { Role: { RoleName: role } },
  { Service: { Id: resources[12][1] } }, { Namespace: { Id: resources[13][1] } },
  { logGroups: [{ logGroupName: resources[14][1] }] },
  { repositories: [{ repositoryName: resources[15][1] }] },
  { ContentLength: 1 }, { ContentLength: 1 },
];
for (let index = 0; index < manifest.resources.length; index++) {
  const single = { ...manifest, resources: [manifest.resources[index]] };
  const result = await observeDeletion(single, async (args) => args[0] === "sts" ? absent(args) : success(present[index]), { attempts: 1 });
  assert.equal(result.status, "CONFIRMED DEFECT", `remaining ${single.resources[0].type} must block deletion proof`);
}

for (const code of ["AccessDenied", "AccessDeniedException", "ThrottlingException", "ExpiredTokenException", "InternalFailure", "ClusterNotFoundException", "403"]) {
  const failed = await observeDeletion(manifest, async (args) => args[0] === "sts" ? absent(args) : error(code), { delayMs: 0 });
  assert.equal(failed.status, "UNVERIFIED", `${code} must not certify absence`);
  assert.equal(failed.observations.length, manifest.resources.length, "an inaccessible resource must not skip other independent checks");
}
for (const payload of ["{}", "null", "not-json"]) {
  const failed = await observeDeletion(manifest, async (args) => args[0] === "sts" ? absent(args) : ({ status: 0, stdout: payload }), { delayMs: 0 });
  assert.equal(failed.status, "UNVERIFIED", "empty, malformed, and mock-mode responses cannot certify absence");
}
const misleading = await observeDeletion(manifest, async (args) => args[0] === "sts" ? absent(args) : { ...error("AccessDenied"), stderr: `${error("AccessDenied").stderr} ResourceNotFoundException NotFound 404` });
assert.equal(misleading.status, "UNVERIFIED");
const noAccount = await observeDeletion(manifest, async () => success({ Account: "999999999999" }));
assert.equal(noAccount.code, "DG_DELETION_ACCOUNT_UNVERIFIED");
assert.deepEqual(noAccount.observations, []);

const one = { ...manifest, resources: [manifest.resources[3]] };
let reads = 0;
const converge = await observeDeletion(one, async (args) => args[0] === "sts" ? absent(args) : ++reads < 3 ? success({ SecurityGroups: [{ GroupId: one.resources[0].id }] }) : error("InvalidGroup.NotFound"), { attempts: 3, delayMs: 0 });
assert.equal(converge.status, "PASS");
assert.equal(converge.observations[0].attempts, 3);
reads = 0;
const residue = await observeDeletion(one, async (args) => args[0] === "sts" ? absent(args) : (++reads, success({ SecurityGroups: [{ GroupId: one.resources[0].id }] })), { attempts: 2, delayMs: 0 });
assert.equal(residue.status, "CONFIRMED DEFECT");
assert.equal(reads, 2, "eventual consistency wait is bounded");
const secret = { ...manifest, resources: [manifest.resources[10]] };
assert.equal((await observeDeletion(secret, async (args) => args[0] === "sts" ? absent(args) : success({ ARN: secret.resources[0].id, DeletedDate: "2026-10-10" }))).status, "CONFIRMED DEFECT", "scheduled secret deletion is not physical removal");
const logs = { ...manifest, resources: [manifest.resources[14]] };
assert.equal((await observeDeletion(logs, async (args) => args[0] === "sts" ? absent(args) : success({ logGroups: [], nextToken: "truncated" }))).status, "UNVERIFIED");
const ecs = { ...manifest, resources: [manifest.resources[1]] };
assert.equal((await observeDeletion(ecs, async (args) => args[0] === "sts" ? absent(args) : success({ services: [], failures: [{ arn: ecs.resources[0].id, reason: "ACCESS_DENIED" }] }))).status, "UNVERIFIED");
const parentAndChild = { ...manifest, resources: [manifest.resources[1], manifest.resources[0]] };
const removedParent = await observeDeletion(parentAndChild, async (args) => args[1] === "describe-services" ? error("ClusterNotFoundException") : absent(args));
assert.equal(removedParent.status, "PASS", "independent exact-cluster absence proves a service absent when AWS cannot describe its deleted cluster");
assert.equal((await observeDeletion(ecs, async (args) => args[0] === "sts" ? absent(args) : error("ClusterNotFoundException"))).status, "UNVERIFIED", "cluster error alone must not certify service deletion");

for (const invalid of [
  { ...manifest, resources: [] }, { ...manifest, resources: [...manifest.resources, manifest.resources[0]] },
  { ...manifest, resources: [{ type: "aws_s3_bucket", id: "shared-state-bucket" }] },
  { ...manifest, resources: [{ type: "aws_security_group", id: "--endpoint-url" }] },
  { ...manifest, scope: { ...scope, accountId: "x" } },
  { ...manifest, resources: [{ ...manifest.resources[0], id: cluster.replace(scope.accountId, "999999999999") }] },
  { ...manifest, resources: [{ ...manifest.resources[16], id: "projects/other/dev/runtime/terraform.tfstate" }] },
]) {
  let invoked = false;
  await assert.rejects(observeDeletion(invalid, async () => { invoked = true; return absent([]); }), /DG_DELETION_SCOPE_INVALID/);
  assert.equal(invoked, false, "invalid scope must fail before AWS access");
}

const tags = { ManagedBy: "DeployGuard", DeployGuardProjectId: scope.projectId };
const stateResources = manifest.resources.slice(0, 15).map((r, i) => ({ mode: "managed", type: r.type, values: { id: r.id, arn: r.id, name: r.id, tags, ...(i === 1 ? { cluster } : {}) } }));
stateResources.push(
  { mode: "managed", type: "random_password", values: { result: "DO-NOT-CAPTURE" } },
  { mode: "managed", type: "aws_secretsmanager_secret_version", values: { secret_id: stateResources[10].values.id, secret_string: "DO-NOT-CAPTURE" } },
  { mode: "managed", type: "aws_iam_role_policy", values: { role, policy: "DO-NOT-CAPTURE" } },
  { mode: "managed", type: "aws_iam_role_policy_attachment", values: { role, policy_arn: "arn:aws:iam::aws:policy/shared" } },
  { mode: "data", type: "aws_vpc", values: { id: "vpc-shared" } },
);
for (const [index, parent] of [[5, { load_balancer_arn: stateResources[4].values.id }], [8, { file_system_id: "fs-123abc" }], [9, { file_system_id: "fs-123abc" }]]) {
  stateResources[index].values = { ...stateResources[index].values, tags: {}, ...parent };
}
const state = { values: { root_module: { resources: stateResources.slice(0, 7), child_modules: [{ resources: stateResources.slice(7) }] } } };
delete stateResources[1].values.arn; // AWS provider exposes ECS service ARN as id, not arn.
const captured = captureDeletionManifest(state, scope);
assert.equal(captured.resources.length, 15);
assert.equal(captured.resources.find((r) => r.type === "aws_ecs_service").id, manifest.resources[1].id);
assert.doesNotMatch(JSON.stringify(captured), /DO-NOT-CAPTURE|vpc-shared|arn:aws:iam::aws/);
validateDeletionManifest(captured);
for (const environment of ["prod", "Dev", null, 42, ""]) {
  for (const index of [0, 5, 16]) {
    const foreign = structuredClone(state);
    const rows = [...foreign.values.root_module.resources, ...foreign.values.root_module.child_modules[0].resources];
    rows[index].values.tags = { ...rows[index].values.tags, Environment: environment };
    assert.throws(() => captureDeletionManifest(foreign, scope), /DG_DELETION_SCOPE_INVALID/,
      "explicit foreign/malformed environments cannot enter a project-scoped inventory, including delegated children");
  }
}
const environmentBound = structuredClone(state);
for (const row of [...environmentBound.values.root_module.resources, ...environmentBound.values.root_module.child_modules[0].resources]) {
  if (row.mode === "managed") row.values.tags = { ...row.values.tags, Environment: scope.environmentName };
}
assert.deepEqual(captureDeletionManifest(environmentBound, scope), captured,
  "matching environment tags preserve identifier-only capture; historical absent tags are not invented");
assert.throws(() => captureDeletionManifest({ values: { root_module: {} } }, scope), /DG_DELETION_SCOPE_INVALID/);
assert.throws(() => captureDeletionManifest({ values: { root_module: { resources: [{ mode: "managed", type: "aws_s3_bucket", values: { id: "shared", tags } }] } } }, scope), /DG_DELETION_SCOPE_INVALID/);
assert.throws(() => captureDeletionManifest({ values: { root_module: { resources: [{ ...stateResources[0], values: { ...stateResources[0].values, tags: {} } }] } } }, scope), /DG_DELETION_SCOPE_INVALID/);
const terraform = readFileSync(new URL("../../infrastructure/railpack-runtime/main.tf", import.meta.url), "utf8");
for (const [, type] of terraform.matchAll(/^resource "([^"]+)"/gm)) assert.ok(stateResources.some((r) => r.type === type), `current Terraform managed resource ${type} must have a tested observation or parent-delegation contract`);
// Invalid CLI input must fail before AWS execution and must not echo input bytes.
const cliTemp = mkdtempSync(join(tmpdir(), "deployguard-observer-cli-"));
try {
  const input = join(cliTemp, "manifest.json");
  const exec = promisify(execFile);
  for (const content of ['"DO-NOT-RETAIN" x', JSON.stringify({ ...manifest, secret: "DO-NOT-RETAIN" })]) {
    writeFileSync(input, content);
    await assert.rejects(exec(process.execPath, [new URL("../../infrastructure/railpack-runtime/observe-deletion.mjs", import.meta.url).pathname, "--manifest", input], {
      timeout: 10000, env: { PATH: cliTemp },
    }), (failure) => {
      assert.equal(failure.stderr, "DG_DELETION_SCOPE_INVALID\n");
      assert.doesNotMatch(failure.stderr, /DO-NOT-RETAIN/);
      assert.equal(failure.stdout, "");
      return true;
    });
  }
} finally {
  rmSync(cliTemp, { recursive: true, force: true });
}

// Node 22 backend callers must be able to require the same validator without
// executing the CLI or encountering an asynchronous module graph.
const requiredObserver = createRequire(import.meta.url)("../../infrastructure/railpack-runtime/observe-deletion.mjs");
assert.equal(requiredObserver.validateDeletionManifest, validateDeletionManifest);

for (const environmentName of ["0", "1dev", "dev-2", "0".repeat(40), "a".repeat(40)]) {
  const valid = { ...one, scope: { ...scope, environmentName } };
  assert.equal(validateDeletionManifest(valid), valid);
  assert.equal(captureDeletionManifest(state, valid.scope).scope.environmentName, environmentName);
}
for (const environmentName of ["", "-dev", "dev_test", "Dev", "dev/other", "dev other", "dev\n", "a".repeat(41), "0".repeat(41), null, 0, ["dev"]]) {
  let invoked = false;
  await assert.rejects(observeDeletion({ ...one, scope: { ...scope, environmentName } }, async () => { invoked = true; }), /DG_DELETION_SCOPE_INVALID/);
  assert.equal(invoked, false, "invalid environments must fail before provider access");
  assert.throws(() => captureDeletionManifest(state, { ...scope, environmentName }), /DG_DELETION_SCOPE_INVALID/);
}

for (const invalid of [
  ...["projectId", "operationId", "accountId", "region"].map((key) => ({ ...one, scope: { ...scope, [key]: [scope[key]] } })),
  { ...one, scope: { ...scope, accountId: Number(scope.accountId) } },
  { ...one, scope: { ...scope, generationIds: [scope.generationIds] } },
  { ...one, resources: [{ ...one.resources[0], type: [one.resources[0].type] }] },
]) {
  let invoked = false;
  await assert.rejects(observeDeletion(invalid, async () => { invoked = true; }), /DG_DELETION_SCOPE_INVALID/);
  assert.equal(invoked, false, "implicit string coercion must not accept non-string ownership identities");
}

const task = { type: "aws_ecs_task", id: arn("ecs", `task/dg-111111111111/${"a".repeat(32)}`), parent: cluster };
const taskManifest = { ...manifest, resources: [task] };
const taskBody = (lastStatus, overrides = {}) => ({ tasks: [{ taskArn: task.id, clusterArn: task.parent, lastStatus, desiredStatus: "STOPPED", ...overrides }], failures: [] });
const taskResult = (body, options = { attempts: 1, delayMs: 0 }) => observeDeletion(taskManifest, async (args) => {
  if (args[0] === "sts") return absent(args);
  assert.deepEqual(args, ["ecs", "describe-tasks", "--cluster", task.parent, "--tasks", task.id, "--region", scope.region, "--output", "json", "--no-cli-pager"]);
  return success(body);
}, options);
assert.equal((await taskResult(taskBody("STOPPED"))).status, "PASS");
for (const status of ["PROVISIONING", "PENDING", "ACTIVATING", "RUNNING", "DEACTIVATING", "STOPPING", "DEPROVISIONING"]) {
  assert.equal((await taskResult(taskBody(status))).status, "CONFIRMED DEFECT", `${status} with desiredStatus STOPPED is still residue`);
}
assert.equal((await taskResult({ tasks: [], failures: [{ arn: task.id, reason: "MISSING" }] })).status, "PASS");
for (const body of [
  taskBody(undefined), taskBody("UNKNOWN"), taskBody("STOPPED", { taskArn: task.id.replace(/a{32}$/, "b".repeat(32)) }),
  taskBody("STOPPED", { clusterArn: arn("ecs", "cluster/foreign") }),
  taskBody("STOPPED", { clusterArn: undefined }),
  { tasks: [], failures: [] }, { tasks: [null], failures: [] },
  { tasks: taskBody("STOPPED").tasks, failures: [{ arn: task.id, reason: "MISSING" }] },
  { tasks: [...taskBody("STOPPED").tasks, ...taskBody("STOPPED").tasks], failures: [] },
  { tasks: [], failures: [{ arn: arn("ecs", "task/foreign"), reason: "MISSING" }] },
  { tasks: [], failures: [{ arn: task.id, reason: "ACCESS_DENIED" }] },
  { tasks: [], failures: [{ arn: task.id, reason: "MISSING" }, { arn: task.id, reason: "MISSING" }] },
  { tasks: [], failures: [null] }, { tasks: [], failures: [{ reason: "MISSING" }] },
  { tasks: [], failures: [{ arn: task.id, reason: "MISSING" }], nextToken: "ambiguous" },
  { tasks: taskBody("STOPPED").tasks }, { tasks: {}, failures: [] },
]) assert.equal((await taskResult(body)).status, "UNVERIFIED", "ambiguous, malformed or foreign task observations cannot certify deletion");

const legacyTask = { ...task, id: arn("ecs", `task/${"c".repeat(32)}`) };
assert.equal((await observeDeletion({ ...taskManifest, resources: [legacyTask] }, async (args) => args[0] === "sts" ? absent(args)
  : success({ tasks: [{ taskArn: legacyTask.id, clusterArn: cluster, lastStatus: "STOPPED" }], failures: [] }))).status, "PASS");
for (const invalidTask of [
  { ...task, parent: undefined }, { ...task, parent: "dg-111111111111" }, { ...task, id: "a".repeat(32) },
  { ...task, parent: arn("ecs", "cluster/foreign") }, { ...task, parent: arn("ecs", "cluster/dg-111111111111/extra") },
  { ...task, parent: arn("ecs", "service/dg-111111111111/app") },
  { ...task, parent: cluster.replace(scope.accountId, "999999999999") }, { ...task, parent: cluster.replace(scope.region, "us-west-2") },
  { ...task, id: task.id.replace(scope.accountId, "999999999999") }, { ...task, id: task.id.replace(scope.region, "us-west-2") },
  { ...task, id: task.id.replace("arn:aws:ecs:", "arn:aws:s3:") }, { ...task, id: task.id.replace("arn:aws:", "arn:aws-cn:") },
  { ...task, id: task.id.slice(0, -1) }, { ...task, id: `${task.id}/extra` }, { ...task, id: task.id.replace(/a{32}$/, "g".repeat(32)) },
  { ...task, id: `${task.id}\n` }, { ...task, parent: "--endpoint-url" },
]) {
  let invoked = false;
  await assert.rejects(observeDeletion({ ...taskManifest, resources: [invalidTask] }, async () => { invoked = true; }), /DG_DELETION_SCOPE_INVALID/);
  assert.equal(invoked, false, "invalid task identity must fail before provider access");
}
assert.throws(() => validateDeletionManifest({ ...taskManifest, resources: [legacyTask, { ...legacyTask, parent: arn("ecs", "cluster/foreign") }] }), /DG_DELETION_SCOPE_INVALID/, "one exact task cannot be assigned conflicting cluster parents");

const taskAndParent = { ...taskManifest, resources: [task, manifest.resources[0]] };
const clusterResponses = [
  [success({ clusters: [], failures: [{ arn: cluster, reason: "MISSING" }] }), "PASS"],
  [success({ clusters: [{ clusterArn: cluster, status: "ACTIVE" }], failures: [] }), "UNVERIFIED"],
  [success({ clusters: [{ clusterArn: cluster, status: "INACTIVE" }], failures: [] }), "UNVERIFIED"],
  [success({ clusters: [], failures: [{ arn: arn("ecs", "cluster/foreign"), reason: "MISSING" }] }), "UNVERIFIED"],
  [error("ClusterNotFoundException"), "UNVERIFIED"], [error("AccessDeniedException"), "UNVERIFIED"],
];
for (const [clusterResponse, expected] of clusterResponses) {
  const order = [];
  const result = await observeDeletion(taskAndParent, async (args) => {
    if (args[0] === "sts") return absent(args);
    order.push(args[1]);
    return args[1] === "describe-clusters" ? clusterResponse : error("ClusterNotFoundException");
  }, { attempts: 1, delayMs: 0 });
  assert.deepEqual(order, ["describe-clusters", "describe-tasks"], "independent cluster absence must be observed before the task");
  assert.equal(result.status, expected);
}
assert.equal((await observeDeletion(taskManifest, async (args) => args[0] === "sts" ? absent(args) : error("ClusterNotFoundException"))).status, "UNVERIFIED");

let taskReads = 0;
const stoppedLater = await observeDeletion(taskManifest, async (args) => args[0] === "sts" ? absent(args)
  : success(taskBody(++taskReads < 3 ? "STOPPING" : "STOPPED")), { attempts: 3, delayMs: 0 });
assert.equal(stoppedLater.status, "PASS");
assert.equal(stoppedLater.observations[0].attempts, 3);
taskReads = 0;
assert.equal((await observeDeletion(taskManifest, async (args) => args[0] === "sts" ? absent(args)
  : (++taskReads, success(taskBody("RUNNING"))), { attempts: 2, delayMs: 0 })).status, "CONFIRMED DEFECT");
assert.equal(taskReads, 2);

const taskState = { values: { root_module: { resources: [stateResources[0], { mode: "managed", type: task.type, values: { id: task.id, arn: task.id, cluster, tags } }] } } };
assert.deepEqual(captureDeletionManifest(taskState, scope).resources, [manifest.resources[0], task]);
const foreignTaskState = structuredClone(taskState);
foreignTaskState.values.root_module.resources[1].values.cluster = arn("ecs", "cluster/foreign");
assert.throws(() => captureDeletionManifest(foreignTaskState, scope), /DG_DELETION_SCOPE_INVALID/);

for (const code of ["Throttling", "ThrottlingException", "ThrottledException", "RequestThrottled", "RequestThrottledException", "RequestLimitExceeded", "TooManyRequestsException", "InternalError", "InternalFailure", "InternalServerError", "InternalServerException", "ServiceUnavailable", "ServiceUnavailableException"]) {
  reads = 0;
  const exhausted = await observeDeletion(one, async (args) => args[0] === "sts" ? absent(args) : (++reads, error(code)), { attempts: 3, delayMs: 0 });
  assert.equal(exhausted.status, "UNVERIFIED");
  assert.equal(exhausted.observations[0].attempts, 3);
  assert.equal(exhausted.observations[0].providerCode, code);
  assert.equal(reads, 3, "verified transient retries must be bounded");
  reads = 0;
  const recovered = await observeDeletion(taskManifest, async (args) => args[0] === "sts" ? absent(args) : ++reads === 1 ? error(code) : success(taskBody("STOPPED")), { attempts: 3, delayMs: 0 });
  assert.equal(recovered.status, "PASS");
  assert.equal(recovered.observations[0].attempts, 2);
  assert.equal(recovered.observations[0].providerCode, null, "success must clear stale provider errors");
}
for (const code of ["AccessDenied", "AccessDeniedException", "UnauthorizedOperation", "ExpiredTokenException", "InvalidClientTokenId", "403", "UnrecognizedClientException", "UnknownError"]) {
  reads = 0;
  const denied = await observeDeletion(one, async (args) => args[0] === "sts" ? absent(args) : (++reads, error(code)), { attempts: 3, delayMs: 0 });
  assert.equal(denied.status, "UNVERIFIED");
  assert.equal(reads, 1, "denial, identity failure and unknown errors must not retry");
  assert.equal(denied.observations[0].providerCode, code);
}
for (const second of [success({ SecurityGroups: [{ GroupId: one.resources[0].id }] }), { status: 0, stdout: "not-json" }, new Error("transport fixture")]) {
  reads = 0;
  const result = await observeDeletion(one, async (args) => {
    if (args[0] === "sts") return absent(args);
    if (++reads === 1) return error("ThrottlingException");
    if (second instanceof Error) throw second;
    return second;
  }, { attempts: 2, delayMs: 0 });
  assert.equal(result.observations[0].providerCode, null, "residue, malformed success and thrown errors must clear stale codes");
  assert.equal(result.status, second instanceof Error || second.stdout === "not-json" ? "UNVERIFIED" : "CONFIRMED DEFECT");
}
for (const stderr of ["transport ThrottlingException", `${error("AccessDenied").stderr}\n${error("ThrottlingException").stderr}`, `${error("ThrottlingException").stderr}\n${error("AccessDenied").stderr}`]) {
  reads = 0;
  const result = await observeDeletion(one, async (args) => args[0] === "sts" ? absent(args) : (++reads, { status: 254, stderr }), { attempts: 3, delayMs: 0 });
  assert.equal(result.status, "UNVERIFIED");
  assert.equal(reads, 1, "unstructured or contradictory provider errors must not retry");
}
reads = 0;
const deniedAfterTransient = await observeDeletion(one, async (args) => args[0] === "sts" ? absent(args) : error(++reads === 1 ? "InternalFailure" : "AccessDenied"), { attempts: 3, delayMs: 0 });
assert.equal(deniedAfterTransient.status, "UNVERIFIED");
assert.equal(reads, 2);
assert.equal(deniedAfterTransient.observations[0].providerCode, "AccessDenied");

for (const [code, expectedAttempts] of [["ThrottlingException", 3], ["AccessDeniedException", 1]]) {
  let accountReads = 0;
  let resourceReads = 0;
  const result = await observeDeletion(one, async (args) => {
    if (args[0] === "sts") { accountReads++; return error(code); }
    resourceReads++;
    return absent(args);
  }, { attempts: 3, delayMs: 0 });
  assert.equal(result.code, "DG_DELETION_ACCOUNT_UNVERIFIED");
  assert.equal(accountReads, expectedAttempts);
  assert.equal(resourceReads, 0, "account identity must be verified before resource reads");
}
let accountReads = 0;
assert.equal((await observeDeletion(one, async (args) => args[0] === "sts" && ++accountReads === 1 ? error("ServiceUnavailable") : absent(args), { attempts: 2, delayMs: 0 })).status, "PASS");
assert.equal(accountReads, 2);

const callerManifest = structuredClone(taskManifest);
const originalCallerManifest = structuredClone(callerManifest);
let releaseAccountCheck;
const observing = observeDeletion(callerManifest, async (args) => {
  if (args[0] === "sts") return new Promise((resolve) => { releaseAccountCheck = resolve; });
  assert.equal(args[3], cluster);
  assert.equal(args[5], task.id);
  assert.equal(args[7], scope.region);
  return success(taskBody("STOPPED"));
});
callerManifest.scope.region = "us-west-2";
callerManifest.scope.generationIds.push("44444444-4444-4444-8444-444444444444");
callerManifest.resources[0].id = task.id.replace(/a{32}$/, "b".repeat(32));
callerManifest.resources[0].parent = arn("ecs", "cluster/foreign");
callerManifest.resources.push({ type: "aws_security_group", id: "sg-foreign" });
releaseAccountCheck(success({ Account: scope.accountId }));
const immutableReport = await observing;
assert.equal(immutableReport.status, "PASS");
assert.deepEqual(immutableReport.scope, originalCallerManifest.scope);
assert.equal(immutableReport.observations.length, 1);
const unchangedReport = await observeDeletion(originalCallerManifest, async (args) => args[0] === "sts" ? absent(args) : success(taskBody("STOPPED")));
assert.equal(immutableReport.manifestSha256, unchangedReport.manifestSha256, "hash and observations must describe the same authority snapshot");
immutableReport.scope.generationIds.push("55555555-5555-4555-8555-555555555555");
assert.deepEqual(originalCallerManifest.scope, scope, "report mutations must not mutate caller authority");

console.log("INDEPENDENT_AWS_DELETION=PASS MOCKED_AWS_ONLY=1 READ_ONLY=1 RESOURCE_FAMILIES=18 STATE_AND_LOCK=1 RESIDUE_AND_ACCESS_FAILURE_FAIL_CLOSED=1 EXACT_TASK_STOPPED_OR_MISSING=1 TRANSIENT_RETRIES_BOUNDED=1 CALLER_SNAPSHOT=1 CLI_SANITIZED=1 NODE22_REQUIRE=1");
