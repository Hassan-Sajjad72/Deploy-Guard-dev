import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
assert.throws(() => captureDeletionManifest({ values: { root_module: {} } }, scope), /DG_DELETION_SCOPE_INVALID/);
assert.throws(() => captureDeletionManifest({ values: { root_module: { resources: [{ mode: "managed", type: "aws_s3_bucket", values: { id: "shared", tags } }] } } }, scope), /DG_DELETION_SCOPE_INVALID/);
assert.throws(() => captureDeletionManifest({ values: { root_module: { resources: [{ ...stateResources[0], values: { ...stateResources[0].values, tags: {} } }] } } }, scope), /DG_DELETION_SCOPE_INVALID/);
const terraform = readFileSync(new URL("../../infrastructure/railpack-runtime/main.tf", import.meta.url), "utf8");
for (const [, type] of terraform.matchAll(/^resource "([^"]+)"/gm)) assert.ok(stateResources.some((r) => r.type === type), `current Terraform managed resource ${type} must have a tested observation or parent-delegation contract`);
console.log("INDEPENDENT_AWS_DELETION=PASS MOCKED_AWS_ONLY=1 READ_ONLY=1 RESOURCE_FAMILIES=17 STATE_AND_LOCK=1 RESIDUE_AND_ACCESS_FAILURE_FAIL_CLOSED=1");
