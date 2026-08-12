import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(__dirname, "../..");
const workflow = readFileSync(resolve(root, ".github/workflows/deployguard-reusable.yml"), "utf8");
const generation = "11111111-1111-4111-8111-111111111111";
const otherGeneration = "22222222-2222-4222-8222-222222222222";

const importableAddresses = [
  "aws_cloudwatch_log_group.app",
  "aws_cloudwatch_log_group.database",
  "aws_cloudwatch_log_group.deployment",
  "aws_secretsmanager_secret.database_password[0]",
  "aws_secretsmanager_secret_version.database_password[0]",
  "aws_secretsmanager_secret.database_url[0]",
  "aws_secretsmanager_secret_version.database_url[0]",
  "aws_efs_file_system.database[0]",
  "aws_efs_access_point.database[0]",
  "aws_security_group.alb",
  "aws_security_group.service",
  "aws_security_group.database[0]",
  "aws_security_group.database_efs[0]",
  "aws_ecs_cluster.app",
  "aws_ecs_service.app",
  "aws_lb.app",
  "aws_iam_role.execution",
] as const;

type Remote = { id: string; generationId: string; managedBy?: string };
class AdoptionFixture {
  imports: Array<{ address: string; id: string }> = [];
  constructor(readonly state: Map<string, Remote>, readonly remotes: Map<string, Remote>, readonly stateReadable = true) {}
  prepare(address: string) {
    if (!this.stateReadable) throw new Error("state read failed");
    const remote = this.remotes.get(address);
    const managed = this.state.get(address);
    if (managed) {
      if (!remote || managed.id !== remote.id || managed.generationId !== generation || remote.generationId !== generation || managed.managedBy !== "DeployGuard" || remote.managedBy !== "DeployGuard") {
        throw new Error("state identity verification failed");
      }
      return "already_managed";
    }
    if (!remote) return "absent";
    if (remote.generationId !== generation || remote.managedBy !== "DeployGuard") throw new Error("ownership verification failed");
    this.imports.push({ address, id: remote.id });
    this.state.set(address, remote);
    return "imported";
  }
}

const cloudwatch = importableAddresses[0];
const owned = (id: string, generationId = generation): Remote => ({ id, generationId, managedBy: "DeployGuard" });
const absentState = new AdoptionFixture(new Map(), new Map([[cloudwatch, owned("/deployguard/project/dev/generation/app")]]));
assert.equal(absentState.prepare(cloudwatch), "imported");
assert.equal(absentState.imports.length, 1, "owned remote resource is imported once when its exact address is absent");
assert.equal(absentState.prepare(cloudwatch), "already_managed");
assert.equal(absentState.imports.length, 1, "repeated preparation never re-imports an already-managed address");

const allManagedState = new Map(importableAddresses.map((address) => [address, owned(`id:${address}`)]));
const allManaged = new AdoptionFixture(allManagedState, new Map(allManagedState));
for (const address of importableAddresses) assert.equal(allManaged.prepare(address), "already_managed");
assert.equal(allManaged.imports.length, 0, "multiple managed resources are all skipped");

const crossGeneration = new AdoptionFixture(new Map(), new Map([[cloudwatch, owned("foreign", otherGeneration)]]));
assert.throws(() => crossGeneration.prepare(cloudwatch), /ownership verification failed/);
assert.equal(crossGeneration.imports.length, 0, "another generation is never adopted");

const missing = new AdoptionFixture(new Map(), new Map());
assert.equal(missing.prepare(cloudwatch), "absent", "no state and no remote resource preserves existing Fresh/Destroy behavior");

const partialDestroy = new AdoptionFixture(
  new Map([[cloudwatch, owned("owned-log")], ["aws_ecs_cluster.app", owned("owned-cluster")]]),
  new Map([[cloudwatch, owned("owned-log")], ["aws_ecs_cluster.app", owned("owned-cluster")], ["aws_lb.app", owned("owned-alb")]]),
);
assert.equal(partialDestroy.prepare(cloudwatch), "already_managed");
assert.equal(partialDestroy.prepare("aws_ecs_cluster.app"), "already_managed");
assert.equal(partialDestroy.prepare("aws_lb.app"), "imported");
assert.deepEqual(partialDestroy.imports, [{ address: "aws_lb.app", id: "owned-alb" }]);
assert.equal(partialDestroy.prepare("aws_lb.app"), "already_managed", "partially completed Destroy retry is idempotent");

assert.throws(() => new AdoptionFixture(new Map([[cloudwatch, owned("wrong")]]), new Map([[cloudwatch, owned("expected")]])).prepare(cloudwatch), /state identity verification failed/, "a state address bound to the wrong remote ID fails closed");
assert.throws(() => new AdoptionFixture(new Map([[cloudwatch, owned("expected", otherGeneration)]]), new Map([[cloudwatch, owned("expected")]])).prepare(cloudwatch), /state identity verification failed/, "another generation at the correct address fails closed");
assert.throws(() => new AdoptionFixture(new Map([[cloudwatch, { id: "expected", generationId: generation }]]), new Map([[cloudwatch, owned("expected")]])).prepare(cloudwatch), /state identity verification failed/, "untagged state objects fail closed");
assert.throws(() => new AdoptionFixture(new Map(), new Map(), false).prepare(cloudwatch), /state read failed/, "state read failures are never absence");

const stateHelper = workflow.indexOf("          state_has() {");
const logGroupReconciler = workflow.indexOf("          reconcile_log_group() {");
assert.ok(stateHelper >= 0 && stateHelper < logGroupReconciler, "state membership is available before the first adoption caller");
assert.match(workflow, /if ! terraform show -json >"\$STATE_JSON_FILE" 2>"\$STATE_JSON_ERROR_FILE"; then[\s\S]*refusing unsafe import preparation/);
assert.match(workflow, /state_resource_json\(\)[\s\S]*def modules: \.?[\s\S]*\.child_modules\[\]\?[\s\S]*select\(\.address == \$address\)/);
assert.doesNotMatch(workflow, /terraform state show -json/);
assert.match(workflow, /state_identity_is_owned\(\)[\s\S]*DeployGuardProjectId[\s\S]*DeployGuardGenerationId/);
assert.match(workflow, /trust_or_import_owned\(\)[\s\S]*state_identity_is_owned "\$address" "\$state_identifier"[\s\S]*import skipped[\s\S]*terraform import -input=false "\$address" "\$import_identifier"/);
assert.match(workflow, /reconcile_ecs_service\(\)[\s\S]*\.services\[0\]\.serviceArn[\s\S]*trust_or_import_owned "aws_ecs_service\.app" "\$RESOURCE_NAME\/\$RESOURCE_NAME" owned "\$arn"/);
assert.match(workflow, /reconcile_database_ecs_service\(\)[\s\S]*\.services\[0\]\.serviceArn[\s\S]*trust_or_import_owned "\$address" "\$RESOURCE_NAME\/\$name" owned "\$arn"/);
assert.equal((workflow.match(/terraform import -input=false/g) || []).length, 1, "all imports pass through the global idempotency primitive");
assert.match(workflow, /reconcile_log_group\(\)[\s\S]*verify[\s\S]*trust_or_import_owned "\$address" "\$name"/);
const stateOnlyDestroy = workflow.match(/- name: Terraform state-only destroy[\s\S]*?- name: Run generation-scoped AWS scavenger/)?.[0] || "";
assert.ok(stateOnlyDestroy, "Destroy uses a separate state-only executor");
assert.doesNotMatch(stateOnlyDestroy, /terraform import/, "Destroy never imports a resource missing from state");
assert.match(stateOnlyDestroy, /terraform show -json > pre-destroy-state\.json/);
assert.match(stateOnlyDestroy, /terraform plan -destroy[\s\S]*terraform apply -input=false -auto-approve deployguard-destroy\.tfplan/);
assert.match(workflow, /Terraform plan and apply\n        if: inputs\.deployment_action == 'deploy'/, "adoption remains deploy-only");
assert.match(workflow, /verify_owned_tags[\s\S]*DeployGuardGenerationId == \$generation/);
for (const address of importableAddresses.filter((item) => !item.includes("cloudwatch_log_group"))) {
  const escaped = address.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  assert.match(workflow, new RegExp(escaped), `workflow retains adoption coverage for ${address}`);
}

console.log("Terraform import idempotency checks passed: Deploy-only owned adoption remains idempotent and Destroy is strictly state-only with no import gate.");
