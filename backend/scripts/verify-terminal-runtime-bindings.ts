import { strict as assert } from "node:assert";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const root = join(__dirname, "..", "..");
const verifier = join(root, "infrastructure", "railpack-runtime", "verify-runtime.sh");
const serviceId = "11111111-1111-4111-8111-111111111111";
const image = `123456789012.dkr.ecr.us-east-1.amazonaws.com/application@sha256:${"a".repeat(64)}`;
const secret = `arn:aws:secretsmanager:us-east-1:123456789012:secret:deployguard/runtime:TOKEN::${"b".repeat(64)}`;
const task = "arn:aws:ecs:us-east-1:123456789012:task-definition/application:7";

function executable(path: string, source: string) {
  writeFileSync(path, source, "utf8");
  chmodSync(path, 0o755);
}

function verify(mode: "correct" | "wrong_env" | "wrong_secret") {
  const directory = mkdtempSync(join(tmpdir(), "deployguard-terminal-bindings-"));
  const bin = join(directory, "bin");
  mkdirSync(bin);
  const outputs = join(directory, "outputs.json");
  const runtime = join(directory, "runtime.json");
  const evidence = join(directory, "evidence.json");
  writeFileSync(outputs, JSON.stringify({ ecs_cluster_name: "cluster", vpc_id: "vpc-1", public_subnet_ids: ["subnet-1"], database: null, services: { [serviceId]: { image, ecs_service_name: "application", task_definition_arn: task, alb_target_group_arn: "target-group", cloudwatch_log_group_name: "/deployguard/application", public_url: "http://application.test", security_group_id: "sg-1" } } }), "utf8");
  writeFileSync(runtime, JSON.stringify({ services: [{ serviceId, environment: { PORT: "8080", HOST: "0.0.0.0", RELEASE: "expected" }, secretReferences: { TOKEN: secret }, databaseAttached: false, managedDatabase: { engine: null, aliases: [] } }] }), "utf8");
  executable(join(bin, "curl"), "#!/usr/bin/env bash\nexit 0\n");
  executable(join(bin, "aws"), `#!/usr/bin/env bash
set -euo pipefail
case "$1 $2" in
  "ecs wait") exit 0 ;;
  "ecs describe-services") printf '%s\n' '{"services":[{"status":"ACTIVE","taskDefinition":"${task}","networkConfiguration":{"awsvpcConfiguration":{"subnets":["subnet-1"],"securityGroups":["sg-1"]}}}]}' ;;
  "ecs describe-task-definition")
    env_value=expected; secret_value='${secret}'
    [ "$BINDING_MODE" != wrong_env ] || env_value=wrong
    [ "$BINDING_MODE" != wrong_secret ] || secret_value='${secret}-wrong'
    jq -cn --arg image '${image}' --arg task '${task}' --arg env "$env_value" --arg secret "$secret_value" '{taskDefinition:{taskDefinitionArn:$task,containerDefinitions:[{name:"application",image:$image,portMappings:[{containerPort:8080}],logConfiguration:{options:{"awslogs-group":"/deployguard/application"}},environment:[{name:"PORT",value:"8080"},{name:"HOST",value:"0.0.0.0"},{name:"RELEASE",value:$env}],secrets:[{name:"TOKEN",valueFrom:$secret}]}]}}' ;;
  "ecs list-tasks") printf '%s\n' '{"taskArns":["running-task"]}' ;;
  "ecs describe-tasks") printf '%s\n' '{"tasks":[{"lastStatus":"RUNNING","taskDefinitionArn":"${task}","containers":[{"name":"application","lastStatus":"RUNNING"}]}]}' ;;
  "ec2 describe-security-groups") printf '%s\n' '{"SecurityGroups":[{"VpcId":"vpc-1"}]}' ;;
  "elbv2 describe-target-health") printf '%s\n' '{"TargetHealthDescriptions":[{"TargetHealth":{"State":"healthy"}}]}' ;;
  *) printf 'unexpected aws command: %s\n' "$*" >&2; exit 2 ;;
esac
`);
  const result = spawnSync("bash", [verifier, outputs, runtime, evidence], { encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, BINDING_MODE: mode } });
  assert.equal(result.status, 0, result.stderr);
  const observed = JSON.parse(readFileSync(evidence, "utf8"));
  rmSync(directory, { recursive: true, force: true });
  return observed;
}

const correct = verify("correct");
assert.equal(correct.verified, true, "exact non-secret and secret bindings pass terminal reconciliation");
assert.equal(correct.services[0].verified, true);
for (const mode of ["wrong_env", "wrong_secret"] as const) {
  const invalid = verify(mode);
  assert.equal(invalid.verified, false, `${mode} must fail terminal reconciliation`);
  assert.equal(invalid.services[0].verified, false);
  assert.equal(invalid.services[0].failureCode, "DG_AWS_RUNTIME_CONFIGURATION_FAILED");
}
console.log("TERMINAL_RUNTIME_BINDINGS=PASS EXACT_ENV=1 EXACT_SECRET_VALUE_FROM=1 PLAINTEXT_SECRET_READ=0");
