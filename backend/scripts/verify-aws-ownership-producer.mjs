import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { initializeOwnership, beginOwnershipWrite, resolveOwnershipWrite, resolveTerraformOwnership, completedOwnership } from "../../infrastructure/railpack-runtime/collect-ownership.mjs";

const scope = { projectId: "11111111-1111-4111-8111-111111111111", operationId: "22222222-2222-4222-8222-222222222222",
  environmentName: "dev", accountId: "123456789012", region: "us-east-1" };
const source = "a".repeat(40);
const initial = initializeOwnership(scope, source, "m0-disposable-state");
assert.deepEqual(initial.resources.map((row) => row.id), [
  `projects/${scope.projectId}/dev/runtime/terraform.tfstate`, `projects/${scope.projectId}/dev/runtime/terraform.tfstate.tflock`]);
assert.deepEqual(completedOwnership(initial), initial, "a pre-write failure has no fabricated AWS resources");
const pending = beginOwnershipWrite(initial, "ecr/publish");
assert.throws(() => completedOwnership(pending), /DG_AWS_OWNERSHIP_INCOMPLETE/, "lost response or interruption cannot certify completeness");
assert.deepEqual(initial.unresolvedIntents, [], "journal transitions do not mutate earlier snapshots");
const repository = { type: "aws_ecr_repository", id: `deployguard-${scope.projectId}` };
const published = resolveOwnershipWrite(pending, "ecr/publish", [repository]);
assert.ok(completedOwnership(published).resources.some((row) => row.id === repository.id));
assert.throws(() => resolveOwnershipWrite(initial, "ecr/publish", [repository]), /DG_AWS_OWNERSHIP_INCOMPLETE/, "receipts require an earlier write intent");
assert.throws(() => beginOwnershipWrite(pending, "ecr/publish"), /DG_AWS_OWNERSHIP_INCOMPLETE/);
const tfPending = beginOwnershipWrite(published, "terraform");
const cluster = `arn:aws:ecs:us-east-1:123456789012:cluster/deployguard-${scope.projectId}`;
const tags = { ManagedBy: "DeployGuard", DeployGuardProjectId: scope.projectId, Environment: "dev" };
const state = { values: { root_module: { resources: [
  { mode: "managed", type: "aws_ecs_cluster", values: { id: cluster, arn: cluster, tags, secretString: "NEVER_RETAIN" } },
  { mode: "managed", type: "aws_ecs_service", values: { id: `${cluster.replace(":cluster/", ":service/")}/application`, cluster, tags } },
] } } };
const collected = resolveTerraformOwnership(tfPending, state);
assert.doesNotMatch(JSON.stringify(collected), /NEVER_RETAIN|secretString/);
assert.equal(collected.resources.length, 5);
assert.deepEqual(completedOwnership(collected).coverage, ["terraform", "ecr", "ecs", "state"]);
const foreign = structuredClone(state); foreign.values.root_module.resources[0].values.tags.Environment = "prod";
assert.throws(() => resolveTerraformOwnership(tfPending, foreign), /DG_DELETION_SCOPE_INVALID/);
assert.throws(() => completedOwnership(tfPending), /DG_AWS_OWNERSHIP_INCOMPLETE/, "failed partial apply cannot be replaced by an empty post-failure inventory");
const ecsPending = beginOwnershipWrite(collected, "ecs/register");
const definition = { type: "aws_ecs_task_definition", id: "arn:aws:ecs:us-east-1:123456789012:task-definition/fixture:2" };
const registered = resolveOwnershipWrite(ecsPending, "ecs/register", [definition]);
assert.ok(completedOwnership(registered).resources.some((row) => row.id === definition.id), "failed activation must retain an already registered revision");
const activationPending = beginOwnershipWrite(registered, "ecs/update");
assert.throws(() => completedOwnership(activationPending), /DG_AWS_OWNERSHIP_INCOMPLETE/);
const invalid = structuredClone(registered); invalid.resources[0].parent = "foreign-state-bucket";
assert.throws(() => completedOwnership(invalid), /DG_AWS_OWNERSHIP_INCOMPLETE/);
const oversized = structuredClone(initial); oversized.resources = Array.from({ length: 1001 }, (_, i) => ({ type: "aws_ecr_repository", id: `repository-${i}` }));
assert.throws(() => completedOwnership(oversized), /DG_DELETION_SCOPE_INVALID/);

// Exercise the actual shell producer, with an injected AWS function that can
// only read/write disposable fixtures. The function refuses a write unless the
// journal already contains its unresolved intent, including conditional callers.
const directory = mkdtempSync(join(tmpdir(), "deployguard-ownership-producer-"));
try {
  mkdirSync(join(directory, ".deployguard"));
  const serviceId = "33333333-3333-4333-8333-333333333333";
  const revision = "44444444-4444-4444-8444-444444444444";
  const oldDefinition = "arn:aws:ecs:us-east-1:123456789012:task-definition/fixture:1";
  const newDefinition = oldDefinition.replace(/:1$/, ":2");
  const service = cluster.replace(":cluster/", ":service/") + "/application";
  const image = `123456789012.dkr.ecr.us-east-1.amazonaws.com/deployguard-${scope.projectId}@sha256:${"b".repeat(64)}`;
  const paths = Object.fromEntries(["outputs", "runtime", "artifacts", "description", "task", "registration", "update", "journal", "calls"].map((name) => [name, join(directory, `${name}.json`)]));
  const write = (path, value) => writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
  write(paths.outputs, { ecs_cluster_name: cluster, ecs_cluster_arn: cluster, services: { [serviceId]: { ecs_service_name: "application",
    task_definition_arn: oldDefinition, transport_probe_port: 65535 } } });
  write(paths.runtime, { services: [{ serviceId, servicePort: 3000, runtimeConfigRevisionId: revision,
    environment: { PORT: "3000", HOST: "0.0.0.0" }, secretReferences: {}, databaseAttached: false, managedDatabase: { aliases: [] } }] });
  write(paths.artifacts, [{ serviceId, servicePort: 3000, runtimeConfigRevisionId: revision, image }]);
  write(paths.description, { services: [{ taskDefinition: oldDefinition, desiredCount: 1 }] });
  write(paths.task, { taskDefinition: { family: "fixture", taskDefinitionArn: oldDefinition, containerDefinitions: [
    { name: "application", portMappings: [{ containerPort: 3000, hostPort: 3000 }] },
    { name: "deployguard-transport-probe", portMappings: [{ containerPort: 65535, hostPort: 65535 }] } ] }, tags: [] });
  write(paths.registration, { taskDefinition: { taskDefinitionArn: newDefinition } });
  const collector = resolve(import.meta.dirname, "../../infrastructure/railpack-runtime/collect-ownership.mjs");
  const script = resolve(import.meta.dirname, "../../infrastructure/railpack-runtime/register-release-task-definitions.sh");
  const shell = String.raw`
    set -euo pipefail
    aws() {
      printf '%s %s\n' "$1" "$2" >> "$FIXTURE_CALLS"
      case "$1 $2" in
        'ecs describe-services') cat "$FIXTURE_DESCRIPTION" ;;
        'ecs describe-task-definition') cat "$FIXTURE_TASK" ;;
        'ecs register-task-definition')
          node -e 'const j=require(process.env.DG_AWS_OWNERSHIP_FILE);if(!j.unresolvedIntents.includes("ecs/"+process.env.FIXTURE_SERVICE+"/register"))process.exit(71)'
          [ "$FIXTURE_FAILURE" != register ] || return 1
          cat "$FIXTURE_REGISTRATION" ;;
        'ecs update-service')
          node -e 'const j=require(process.env.DG_AWS_OWNERSHIP_FILE);if(!j.unresolvedIntents.includes("ecs/"+process.env.FIXTURE_SERVICE+"/update"))process.exit(72)'
          [ "$FIXTURE_FAILURE" != update ] || return 1
          cat "$FIXTURE_UPDATE" ;;
        *) return 99 ;;
      esac
    }
    source "$FIXTURE_SCRIPT" "$FIXTURE_OUTPUTS" "$FIXTURE_RUNTIME" "$FIXTURE_ARTIFACTS" deploy "$FIXTURE_MODE"
  `;
  for (const [mode, failure] of [["release_only", "none"], ["release_only", "register"], ["release_only", "update"], ["terraform", "none"]]) {
    write(paths.journal, initial); writeFileSync(paths.calls, "", { mode: 0o600 });
    write(paths.update, { service: { clusterArn: cluster, serviceArn: service, taskDefinition: mode === "terraform" ? oldDefinition : newDefinition } });
    const executed = spawnSync("bash", ["-c", shell], { cwd: directory, encoding: "utf8", timeout: 30000,
      env: { ...process.env, DG_AWS_OWNERSHIP_FILE: paths.journal, DG_AWS_OWNERSHIP_COLLECTOR: collector, FIXTURE_SERVICE: serviceId,
        FIXTURE_CALLS: paths.calls, FIXTURE_DESCRIPTION: paths.description, FIXTURE_TASK: paths.task, FIXTURE_REGISTRATION: paths.registration,
        FIXTURE_UPDATE: paths.update, FIXTURE_FAILURE: failure, FIXTURE_SCRIPT: script, FIXTURE_OUTPUTS: paths.outputs,
        FIXTURE_RUNTIME: paths.runtime, FIXTURE_ARTIFACTS: paths.artifacts, FIXTURE_MODE: mode } });
    const retained = JSON.parse(readFileSync(paths.journal, "utf8"));
    const calls = readFileSync(paths.calls, "utf8");
    if (failure === "none") {
      assert.equal(executed.status, 0, `mode=${mode} stderr=${executed.stderr} intents=${JSON.stringify(retained.unresolvedIntents)} calls=${calls}`);
      assert.ok(completedOwnership(retained).resources.some((row) => row.id === (mode === "terraform" ? oldDefinition : newDefinition)));
      assert.ok(retained.resources.some((row) => row.id === service && row.parent === cluster));
    } else {
      assert.notEqual(executed.status, 0, "lost registration/activation responses stay failed");
      assert.throws(() => completedOwnership(retained), /DG_AWS_OWNERSHIP_INCOMPLETE/);
      if (failure === "register") assert.doesNotMatch(calls, /update-service/, "lost registration must prevent activation");
      else assert.ok(retained.resources.some((row) => row.id === newDefinition), "a registered revision survives failed activation");
    }
  }
  const verifier = readFileSync(resolve(import.meta.dirname, "../../infrastructure/railpack-runtime/verify-runtime.sh"), "utf8");
  const activation = verifier.match(/release_database_attached_service\(\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(activation);
  const conditional = spawnSync("bash", ["-c", `${activation}\nnode() { return 1; }\nownership_failure() { exit 73; }\naws() { exit 74; }\nif release_database_attached_service fixture cluster application; then exit 75; fi`],
    { encoding: "utf8", env: { ...process.env, DG_AWS_OWNERSHIP_FILE: paths.journal, DG_AWS_OWNERSHIP_COLLECTOR: collector } });
  assert.equal(conditional.status, 73, "conditional Bash callers must not suppress retention failure and proceed to AWS");
} finally { rmSync(directory, { recursive: true, force: true }); }
console.log("AWS_OWNERSHIP_PRODUCER=PASS PRE_WRITE_INTENTS=1 PARTIAL_INTERRUPTED_FAIL_CLOSED=1 IDENTIFIER_ONLY=1 HISTORICAL_SNAPSHOTS_PRESERVED=1 AWS_EXECUTION=NONE");
