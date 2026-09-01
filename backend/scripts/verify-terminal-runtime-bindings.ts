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
const ecsService = "arn:aws:ecs:us-east-1:123456789012:service/cluster/application";

function executable(path: string, source: string) {
  writeFileSync(path, source, "utf8");
  chmodSync(path, 0o755);
}

function verify(mode: "correct" | "wrong_env" | "wrong_secret" | "wrong_port" | "empty_diagnostics" | "target_converges" | "target_timeout") {
  const directory = mkdtempSync(join(tmpdir(), "deployguard-terminal-bindings-"));
  const bin = join(directory, "bin");
  mkdirSync(bin);
  const outputs = join(directory, "outputs.json");
  const runtime = join(directory, "runtime.json");
  const evidence = join(directory, "evidence.json");
  writeFileSync(outputs, JSON.stringify({ ecs_cluster_name: "cluster", vpc_id: "vpc-1", public_subnet_ids: ["subnet-1"], database: null, services: { [serviceId]: { image, service_port: 8080, ecs_service_arn: ecsService, ecs_service_name: "application", task_definition_arn: task, alb_target_group_arn: "target-group", cloudwatch_log_group_name: "/deployguard/application", public_url: "http://application.test", security_group_id: "sg-1", alb_security_group_id: "sg-alb" } } }), "utf8");
  writeFileSync(runtime, JSON.stringify({ services: [{ serviceId, servicePort: 8080, environment: { PORT: "8080", HOST: "0.0.0.0", RELEASE: "expected" }, secretReferences: { TOKEN: secret }, databaseAttached: false, managedDatabase: { engine: null, aliases: [] } }] }), "utf8");
  executable(join(bin, "curl"), "#!/usr/bin/env bash\nexit 0\n");
  const counter = join(directory, "target-health-count");
  executable(join(bin, "aws"), `#!/usr/bin/env bash
    set -euo pipefail
    case "$1 $2" in
  "ecs wait") [ "$BINDING_MODE" != empty_diagnostics ] ;;
  "ecs describe-services") printf '%s\n' '{"services":[{"status":"ACTIVE","taskDefinition":"${task}","networkConfiguration":{"awsvpcConfiguration":{"subnets":["subnet-1"],"securityGroups":["sg-1"]}},"loadBalancers":[{"targetGroupArn":"target-group","containerName":"application","containerPort":8080}]}]}' ;;
  "ecs describe-task-definition")
    env_value=expected; secret_value='${secret}'
    [ "$BINDING_MODE" != wrong_env ] || env_value=wrong
    [ "$BINDING_MODE" != wrong_secret ] || secret_value='${secret}-wrong'
    runtime_port=8080; [ "$BINDING_MODE" != wrong_port ] || runtime_port=9090
    jq -cn --arg image '${image}' --arg task '${task}' --arg env "$env_value" --arg secret "$secret_value" --argjson port "$runtime_port" '{taskDefinition:{taskDefinitionArn:$task,containerDefinitions:[{name:"application",image:$image,portMappings:[{containerPort:$port,hostPort:$port}],logConfiguration:{options:{"awslogs-group":"/deployguard/application"}},environment:[{name:"PORT",value:"8080"},{name:"HOST",value:"0.0.0.0"},{name:"RELEASE",value:$env}],secrets:[{name:"TOKEN",valueFrom:$secret}]}]}}' ;;
  "ecs list-tasks")
    if [[ "$*" == *"--desired-status STOPPED"* ]]; then printf '%s\n' '{"taskArns":[]}'
    else printf '%s\n' '{"taskArns":["running-task"]}'; fi ;;
  "ecs describe-tasks") printf '%s\n' '{"tasks":[{"lastStatus":"RUNNING","taskDefinitionArn":"${task}","containers":[{"name":"application","lastStatus":"RUNNING"}],"attachments":[{"details":[{"name":"privateIPv4Address","value":"10.0.0.5"}]}]}]}' ;;
  "ec2 describe-security-groups") printf '%s\n' '{"SecurityGroups":[{"VpcId":"vpc-1","IpPermissions":[{"FromPort":8080,"ToPort":8080,"UserIdGroupPairs":[{"GroupId":"sg-alb"}]}]}]}' ;;
  "elbv2 describe-target-groups") printf '%s\n' '{"TargetGroups":[{"VpcId":"vpc-1","Port":8080,"Protocol":"HTTP"}]}' ;;
  "elbv2 describe-target-health")
    if [ "$BINDING_MODE" = empty_diagnostics ] || [ "$BINDING_MODE" = target_timeout ]; then
      printf '%s\n' '{"TargetHealthDescriptions":[]}'
    elif [ "$BINDING_MODE" = target_converges ]; then
      count=0; [ ! -f '${counter}' ] || count="$(cat '${counter}')"; count=$((count + 1)); printf '%s' "$count" > '${counter}'
      if [ "$count" -lt 2 ]; then printf '%s\n' '{"TargetHealthDescriptions":[{"Target":{"Id":"10.0.0.5"},"TargetHealth":{"State":"initial","Reason":"Elb.RegistrationInProgress"}}]}'
      else printf '%s\n' '{"TargetHealthDescriptions":[{"Target":{"Id":"10.0.0.5"},"TargetHealth":{"State":"healthy"}}]}'; fi
    else printf '%s\n' '{"TargetHealthDescriptions":[{"Target":{"Id":"10.0.0.5"},"TargetHealth":{"State":"healthy"}}]}'; fi ;;
  "logs filter-log-events") printf '%s\n' '{"events":[]}' ;;
  *) printf 'unexpected aws command: %s\n' "$*" >&2; exit 2 ;;
esac
`);
  const result = spawnSync("bash", [verifier, outputs, runtime, evidence], { encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, BINDING_MODE: mode, DEPLOYGUARD_TARGET_HEALTH_MAX_ATTEMPTS: "3", DEPLOYGUARD_TARGET_HEALTH_INTERVAL_SECONDS: "0" } });
  const observed = JSON.parse(readFileSync(evidence, "utf8"));
  rmSync(directory, { recursive: true, force: true });
  return { observed, result };
}

const { observed: correct, result: correctResult } = verify("correct");
assert.equal(correctResult.status, 0, correctResult.stderr);
assert.equal(correct.verified, true, "exact non-secret and secret bindings pass terminal reconciliation");
assert.equal(correct.services[0].verified, true);
assert.equal(correct.services[0].image, image);
assert.equal(correct.services[0].ecsServiceArn, ecsService);
assert.equal(correct.services[0].taskDefinitionArn, task);
assert.deepEqual(correct.services[0].runningTaskArns, ["running-task"]);
assert.equal(correct.services[0].runtimePort, 8080);
assert.equal(correct.services[0].targetGroupArn, "target-group");
assert.deepEqual(correct.services[0].targetHealth, ["healthy"]);
assert.deepEqual(correct.services[0].environment, { PORT: "8080", HOST: "0.0.0.0", RELEASE: "expected" });
assert.deepEqual(correct.services[0].secretValueFrom, { TOKEN: secret });
assert.deepEqual(correct.services[0].managedDatabase, { attached: false, attachedServiceId: null, engine: null, aliases: [], credentialsSecretArn: null, secretVersionId: null });
assert.equal(correct.services[0].publicUrl, "http://application.test");
assert.equal(correct.services[0].publicEndpointVerified, true);
for (const mode of ["wrong_env", "wrong_secret", "wrong_port"] as const) {
  const { observed: invalid, result } = verify(mode);
  assert.notEqual(result.status, 0, `${mode} must propagate terminal verification failure`);
  assert.equal(invalid.verified, false, `${mode} must fail terminal reconciliation`);
  assert.equal(invalid.services[0].verified, false);
  assert.equal(invalid.services[0].failureCode, "DG_AWS_RUNTIME_CONFIGURATION_FAILED");
}
const converged = verify("target_converges");
assert.equal(converged.result.status, 0, converged.result.stderr);
assert.equal(converged.observed.verified, true, "bounded target-health observation accepts the exact target set after it converges");
const timedOut = verify("target_timeout");
assert.notEqual(timedOut.result.status, 0, "target-health convergence timeout must fail terminal verification");
assert.match(timedOut.result.stderr, new RegExp(`DG_FAILURE serviceId=${serviceId} code=DG_ECS_STABILITY_FAILED stage=ecs_stability`));
const emptyDiagnostics = verify("empty_diagnostics");
assert.notEqual(emptyDiagnostics.result.status, 0);
assert.match(emptyDiagnostics.result.stderr, /DG_ECS_DIAGNOSTICS/);
assert.match(emptyDiagnostics.result.stderr, new RegExp(`DG_FAILURE serviceId=${serviceId} code=DG_ECS_STABILITY_FAILED stage=ecs_stability`));
assert.doesNotMatch(emptyDiagnostics.result.stderr, /Cannot iterate over null|jq: error/, "empty stopped tasks, containers, ECS events, targets, and log events remain null-safe");
console.log("TERMINAL_RUNTIME_BINDINGS=PASS EXACT_ENV=1 EXACT_SECRET_VALUE_FROM=1 FAILURE_PROPAGATION=1 NULL_SAFE_DIAGNOSTICS=1 TARGET_HEALTH_CONVERGENCE=1");
