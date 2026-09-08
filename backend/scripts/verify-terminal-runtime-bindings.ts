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

function verify(mode: "correct" | "http_404" | "http_500" | "template_exception" | "business_error" | "wrong_env" | "wrong_secret" | "wrong_port" | "empty_diagnostics" | "target_converges" | "target_timeout" | "old_target_draining" | "unexpected_target_healthy" | "expected_target_unhealthy" | "alb_provisioning_then_active" | "alb_timeout" | "alb_elapsed_deadline" | "listener_mismatch" | "dns_unresolved_then_resolves" | "dns_timeout" | "connection_refused_then_success" | "connection_reset_then_success" | "connection_timeout_then_success" | "persistent_connection_failure" | "alb_502_then_success" | "alb_503_then_success" | "alb_504_then_success" | "persistent_alb_502" | "persistent_alb_503" | "persistent_alb_504" | "cloud_map_empty_then_registered" | "cloud_map_timeout") {
  const directory = mkdtempSync(join(tmpdir(), "deployguard-terminal-bindings-"));
  const bin = join(directory, "bin");
  mkdirSync(bin);
  const outputs = join(directory, "outputs.json");
  const runtime = join(directory, "runtime.json");
  const evidence = join(directory, "evidence.json");
  const databaseMode = mode === "cloud_map_empty_then_registered" || mode === "cloud_map_timeout";
  const database = databaseMode ? { attached_service_id: serviceId, engine: "postgres", host: "database.internal", port: 5432, ecs_service_name: "database-service", task_definition_arn: "database-task-definition", cloudwatch_log_group_name: "/deployguard/database", cloud_map_service_id: "cloud-map-service", cloud_map_service_arn: "cloud-map-service-arn", security_group_id: "sg-db", credentials_secret_arn: "arn:aws:secretsmanager:us-east-1:123456789012:secret:database", secret_version_id: "database-secret-version-000000000000" } : null;
  writeFileSync(outputs, JSON.stringify({ ecs_cluster_name: "cluster", vpc_id: "vpc-1", public_subnet_ids: ["subnet-1"], database, services: { [serviceId]: { image, service_port: 8080, ecs_service_arn: ecsService, ecs_service_name: "application", task_definition_arn: task, alb_arn: "load-balancer", alb_target_group_arn: "target-group", cloudwatch_log_group_name: "/deployguard/application", public_url: "http://application.test", security_group_id: "sg-1", alb_security_group_id: "sg-alb", transport_probe_container_name: "deployguard-transport-probe", transport_probe_port: 65535, platform_health_check_path: "/_deployguard/transport-ready" } } }), "utf8");
  writeFileSync(runtime, JSON.stringify({ services: [{ serviceId, servicePort: 8080, environment: { PORT: "8080", HOST: "0.0.0.0", RELEASE: "expected" }, secretReferences: { TOKEN: secret }, databaseAttached: databaseMode, managedDatabase: databaseMode ? { engine: "postgres", aliases: [] } : { engine: null, aliases: [] } }] }), "utf8");
  const publicCounter = join(directory, "public-count");
  const albCounter = join(directory, "alb-count");
  const dnsCounter = join(directory, "dns-count");
  const cloudMapCounter = join(directory, "cloud-map-count");
  executable(join(bin, "curl"), `#!/usr/bin/env bash
set -euo pipefail
count=0; [ ! -f '${publicCounter}' ] || count="$(cat '${publicCounter}')"; count=$((count + 1)); printf '%s' "$count" > '${publicCounter}'
status=200; exit_code=0
case "$BINDING_MODE" in
  http_404) status=404 ;;
  http_500|template_exception|business_error) status=500 ;;
  connection_refused_then_success) if [ "$count" -eq 1 ]; then status=000; exit_code=7; echo 'curl: (7) connection refused token=top-secret' >&2; fi ;;
  connection_reset_then_success) if [ "$count" -eq 1 ]; then status=000; exit_code=56; echo 'curl: (56) connection reset' >&2; fi ;;
  connection_timeout_then_success) if [ "$count" -eq 1 ]; then status=000; exit_code=28; echo 'curl: (28) timed out' >&2; fi ;;
  persistent_connection_failure) status=000; exit_code=7; echo 'curl: (7) connection refused token=top-secret' >&2 ;;
  alb_502_then_success) [ "$count" -gt 1 ] || status=502 ;;
  alb_503_then_success) [ "$count" -gt 1 ] || status=503 ;;
  alb_504_then_success) [ "$count" -gt 1 ] || status=504 ;;
  persistent_alb_502) status=502 ;;
  persistent_alb_503) status=503 ;;
  persistent_alb_504) status=504 ;;
esac
printf '%s\\t%s\\t%s\\t%s\\t%s' "$status" '203.0.113.10' '0.010' '0.020' '0.021'
exit "$exit_code"
`);
  executable(join(bin, "getent"), `#!/usr/bin/env bash
set -euo pipefail
count=0; [ ! -f '${dnsCounter}' ] || count="$(cat '${dnsCounter}')"; count=$((count + 1)); printf '%s' "$count" > '${dnsCounter}'
if [ "$BINDING_MODE" = dns_timeout ] || { [ "$BINDING_MODE" = dns_unresolved_then_resolves ] && [ "$count" -eq 1 ]; }; then exit 2; fi
printf '%s\\n' '203.0.113.10 STREAM application.test' '203.0.113.11 STREAM application.test'
`);
  const counter = join(directory, "target-health-count");
  executable(join(bin, "aws"), `#!/usr/bin/env bash
    set -euo pipefail
    case "$1 $2" in
  "ecs wait") [ "$BINDING_MODE" != empty_diagnostics ] ;;
  "ecs describe-services")
    if [[ "$*" == *"--services database-service"* ]]; then printf '%s\n' '{"services":[{"status":"ACTIVE","taskDefinition":"database-task-definition","serviceRegistries":[{"registryArn":"cloud-map-service-arn"}]}]}'
    else printf '%s\n' '{"services":[{"status":"ACTIVE","taskDefinition":"${task}","networkConfiguration":{"awsvpcConfiguration":{"subnets":["subnet-1"],"securityGroups":["sg-1"]}},"loadBalancers":[{"targetGroupArn":"target-group","containerName":"application","containerPort":8080}]}]}'; fi ;;
  "ecs describe-task-definition")
    env_value=expected; secret_value='${secret}'
    [ "$BINDING_MODE" != wrong_env ] || env_value=wrong
    [ "$BINDING_MODE" != wrong_secret ] || secret_value='${secret}-wrong'
    runtime_port=8080; [ "$BINDING_MODE" != wrong_port ] || runtime_port=9090
    jq -cn --arg image '${image}' --arg task '${task}' --arg env "$env_value" --arg secret "$secret_value" --argjson port "$runtime_port" '{taskDefinition:{taskDefinitionArn:$task,containerDefinitions:[{name:"application",image:$image,portMappings:[{containerPort:$port,hostPort:$port}],logConfiguration:{options:{"awslogs-group":"/deployguard/application"}},environment:[{name:"PORT",value:"8080"},{name:"HOST",value:"0.0.0.0"},{name:"RELEASE",value:$env}],secrets:[{name:"TOKEN",valueFrom:$secret}]},{name:"deployguard-transport-probe",essential:true,image:"public.ecr.aws/docker/library/busybox:1.36.1@sha256:73aaf090f3d85aa34ee199857f03fa3a95c8ede2ffd4cc2cdb5b94e566b11662",portMappings:[{containerPort:65535,hostPort:65535}],environment:[{name:"APPLICATION_PORT",value:"8080"},{name:"PROBE_PORT",value:"65535"}]}]}}' ;;
  "ecs list-tasks")
    if [[ "$*" == *"--desired-status STOPPED"* ]]; then printf '%s\n' '{"taskArns":[]}'
    elif [[ "$*" == *"--service-name database-service"* ]]; then printf '%s\n' '{"taskArns":["database-task"]}'
    else printf '%s\n' '{"taskArns":["running-task"]}'; fi ;;
  "ecs describe-tasks")
    if [[ "$*" == *"database-task"* ]]; then printf '%s\n' '{"tasks":[{"lastStatus":"RUNNING","healthStatus":"HEALTHY","taskDefinitionArn":"database-task-definition","containers":[{"name":"database","lastStatus":"RUNNING","healthStatus":"HEALTHY"}],"attachments":[{"details":[{"name":"privateIPv4Address","value":"10.0.0.9"}]}]}]}'
    else printf '%s\n' '{"tasks":[{"lastStatus":"RUNNING","taskDefinitionArn":"${task}","containers":[{"name":"application","lastStatus":"RUNNING"}],"attachments":[{"details":[{"name":"privateIPv4Address","value":"10.0.0.5"}]}]}]}'; fi ;;
  "ecs update-service") printf '%s\n' '{"service":{"serviceName":"application","desiredCount":1}}' ;;
  "ec2 describe-security-groups")
    if [[ "$*" == *"--group-ids sg-alb"* ]]; then printf '%s\n' '{"SecurityGroups":[{"VpcId":"vpc-1","IpPermissions":[{"IpProtocol":"tcp","FromPort":80,"ToPort":80,"IpRanges":[{"CidrIp":"0.0.0.0/0"}]}]}]}'
    elif [[ "$*" == *"--group-ids sg-db"* ]]; then printf '%s\n' '{"SecurityGroups":[{"VpcId":"vpc-1","IpPermissions":[{"FromPort":5432,"ToPort":5432,"UserIdGroupPairs":[{"GroupId":"sg-1"}]}]}]}'
    else printf '%s\n' '{"SecurityGroups":[{"VpcId":"vpc-1","IpPermissions":[{"FromPort":8080,"ToPort":8080,"UserIdGroupPairs":[{"GroupId":"sg-alb"}]},{"FromPort":65535,"ToPort":65535,"UserIdGroupPairs":[{"GroupId":"sg-alb"}]}]}]}'; fi ;;
  "elbv2 describe-load-balancers")
    count=0; [ ! -f '${albCounter}' ] || count="$(cat '${albCounter}')"; count=$((count + 1)); printf '%s' "$count" > '${albCounter}'
    state=active; if [ "$BINDING_MODE" = alb_timeout ] || [ "$BINDING_MODE" = alb_elapsed_deadline ] || { [ "$BINDING_MODE" = alb_provisioning_then_active ] && [ "$count" -eq 1 ]; }; then state=provisioning; fi
    jq -cn --arg state "$state" '{LoadBalancers:[{LoadBalancerArn:"load-balancer",DNSName:"application.test",Scheme:"internet-facing",Type:"application",IpAddressType:"ipv4",SecurityGroups:["sg-alb"],State:{Code:$state}}]}' ;;
  "elbv2 describe-listeners")
    target=target-group; [ "$BINDING_MODE" != listener_mismatch ] || target=other-target-group
    jq -cn --arg target "$target" '{Listeners:[{ListenerArn:"listener",Port:80,Protocol:"HTTP",DefaultActions:[{Type:"forward",TargetGroupArn:$target}]}]}' ;;
  "elbv2 describe-target-groups") printf '%s\n' '{"TargetGroups":[{"VpcId":"vpc-1","Port":8080,"Protocol":"HTTP","HealthCheckPort":"65535","HealthCheckPath":"/_deployguard/transport-ready","Matcher":{"HttpCode":"200-299"}}]}' ;;
  "elbv2 describe-target-health")
    if [ "$BINDING_MODE" = empty_diagnostics ] || [ "$BINDING_MODE" = target_timeout ]; then
      printf '%s\n' '{"TargetHealthDescriptions":[]}'
    elif [ "$BINDING_MODE" = old_target_draining ]; then
      printf '%s\n' '{"TargetHealthDescriptions":[{"Target":{"Id":"10.0.0.4","Port":8080},"TargetHealth":{"State":"draining"}},{"Target":{"Id":"10.0.0.5","Port":8080},"TargetHealth":{"State":"healthy"}}]}'
    elif [ "$BINDING_MODE" = unexpected_target_healthy ]; then
      printf '%s\n' '{"TargetHealthDescriptions":[{"Target":{"Id":"10.0.0.4","Port":8080},"TargetHealth":{"State":"healthy"}},{"Target":{"Id":"10.0.0.5","Port":8080},"TargetHealth":{"State":"healthy"}}]}'
    elif [ "$BINDING_MODE" = expected_target_unhealthy ]; then
      printf '%s\n' '{"TargetHealthDescriptions":[{"Target":{"Id":"10.0.0.5","Port":8080},"TargetHealth":{"State":"unhealthy","Reason":"Target.ResponseCodeMismatch"}}]}'
    elif [ "$BINDING_MODE" = target_converges ]; then
      count=0; [ ! -f '${counter}' ] || count="$(cat '${counter}')"; count=$((count + 1)); printf '%s' "$count" > '${counter}'
      if [ "$count" -lt 2 ]; then printf '%s\n' '{"TargetHealthDescriptions":[{"Target":{"Id":"10.0.0.5","Port":8080},"TargetHealth":{"State":"initial","Reason":"Elb.RegistrationInProgress"}}]}'
      else printf '%s\n' '{"TargetHealthDescriptions":[{"Target":{"Id":"10.0.0.5","Port":8080},"TargetHealth":{"State":"healthy"}}]}'; fi
    else printf '%s\n' '{"TargetHealthDescriptions":[{"Target":{"Id":"10.0.0.5","Port":8080},"TargetHealth":{"State":"healthy"}}]}'; fi ;;
  "servicediscovery get-service") printf '%s\n' '{"Service":{"Type":"DNS_HTTP"}}' ;;
  "servicediscovery list-instances")
    count=0; [ ! -f '${cloudMapCounter}' ] || count="$(cat '${cloudMapCounter}')"; count=$((count + 1)); printf '%s' "$count" > '${cloudMapCounter}'
    if [ "$BINDING_MODE" = cloud_map_timeout ] || { [ "$BINDING_MODE" = cloud_map_empty_then_registered ] && [ "$count" -eq 1 ]; }; then printf '%s\n' '{"Instances":[]}'
    else printf '%s\n' '{"Instances":[{"Attributes":{"AWS_INSTANCE_IPV4":"10.0.0.9"}}]}'; fi ;;
  "logs filter-log-events") printf '%s\n' '{"events":[]}' ;;
  *) printf 'unexpected aws command: %s\n' "$*" >&2; exit 2 ;;
esac
`);
  const result = spawnSync("bash", [verifier, outputs, runtime, evidence], { encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, BINDING_MODE: mode, DEPLOYGUARD_TARGET_HEALTH_MAX_ATTEMPTS: "3", DEPLOYGUARD_TARGET_HEALTH_INTERVAL_SECONDS: "0", DEPLOYGUARD_TARGET_HEALTH_MAX_ELAPSED_SECONDS: "10", DEPLOYGUARD_ALB_MAX_ATTEMPTS: mode === "alb_elapsed_deadline" ? "20" : "3", DEPLOYGUARD_ALB_INTERVAL_SECONDS: mode === "alb_elapsed_deadline" ? "2" : "0", DEPLOYGUARD_ALB_MAX_ELAPSED_SECONDS: mode === "alb_elapsed_deadline" ? "1" : "10", DEPLOYGUARD_LISTENER_MAX_ATTEMPTS: "3", DEPLOYGUARD_LISTENER_INTERVAL_SECONDS: "0", DEPLOYGUARD_LISTENER_MAX_ELAPSED_SECONDS: "10", DEPLOYGUARD_DNS_MAX_ATTEMPTS: "3", DEPLOYGUARD_DNS_INTERVAL_SECONDS: "0", DEPLOYGUARD_DNS_MAX_ELAPSED_SECONDS: "10", DEPLOYGUARD_DNS_ATTEMPT_TIMEOUT_SECONDS: "1", DEPLOYGUARD_PUBLIC_MAX_ATTEMPTS: "3", DEPLOYGUARD_PUBLIC_INTERVAL_SECONDS: "0", DEPLOYGUARD_PUBLIC_MAX_ELAPSED_SECONDS: "10", DEPLOYGUARD_PUBLIC_CONNECT_TIMEOUT_SECONDS: "1", DEPLOYGUARD_PUBLIC_ATTEMPT_TIMEOUT_SECONDS: "1", DEPLOYGUARD_ECS_STABILITY_TIMEOUT_SECONDS: "5", DEPLOYGUARD_DATABASE_READINESS_MAX_ELAPSED_SECONDS: "10", DEPLOYGUARD_CLOUD_MAP_MAX_ATTEMPTS: "3", DEPLOYGUARD_CLOUD_MAP_INTERVAL_SECONDS: "0", DEPLOYGUARD_CLOUD_MAP_MAX_ELAPSED_SECONDS: "10" } });
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
assert.deepEqual(correct.services[0].taskIpAddresses, ["10.0.0.5"]);
assert.equal(correct.services[0].runtimePort, 8080);
assert.equal(correct.services[0].readinessMode, "platform_transport");
assert.equal(correct.services[0].applicationReachabilityPath, "alb_to_task_eni");
assert.equal(correct.services[0].transportProbePort, 65535);
assert.equal(correct.services[0].platformHealthCheckPath, "/_deployguard/transport-ready");
assert.equal(correct.services[0].targetGroupArn, "target-group");
assert.deepEqual(correct.services[0].targetHealth, ["healthy"]);
assert.deepEqual(correct.services[0].targetRegistrations, [{ targetId: "10.0.0.5", port: 8080, state: "healthy" }], "terminal evidence binds ALB health to the exact current task ENI and service port");
assert.deepEqual(correct.services[0].environment, { PORT: "8080", HOST: "0.0.0.0", RELEASE: "expected" });
assert.deepEqual(correct.services[0].secretValueFrom, { TOKEN: secret });
assert.deepEqual(correct.services[0].managedDatabase, { attached: false, attachedServiceId: null, engine: null, aliases: [], credentialsSecretArn: null, secretVersionId: null });
assert.equal(correct.services[0].publicUrl, "http://application.test");
assert.equal(correct.services[0].publicEndpointVerified, true);
assert.equal(correct.services[0].alb.state, "active");
assert.equal(correct.services[0].listener.defaultTargetGroupArn, "target-group");
assert.equal(correct.services[0].publicProbe.classification, "READY");
assert.deepEqual(correct.services[0].publicProbe.resolvedIpAddresses, ["203.0.113.10", "203.0.113.11"]);
assert.equal(correct.services[0].publicProbe.httpStatus, "200");
for (const mode of ["http_404", "http_500", "template_exception", "business_error"] as const) {
  const applicationResponse = verify(mode);
  assert.equal(applicationResponse.result.status, 0, `${mode} is an application concern after TCP/routing readiness: ${applicationResponse.result.stderr}`);
  assert.equal(applicationResponse.observed.verified, true, `${mode} must remain deployable by default`);
}
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
const rolling = verify("old_target_draining");
assert.equal(rolling.result.status, 0, rolling.result.stderr);
assert.equal(rolling.observed.verified, true, "a healthy current ECS task target passes while an old target is legitimately draining");
assert.deepEqual(rolling.observed.services[0].targetHealth, ["healthy"], "release evidence describes current expected target health only");
assert.deepEqual(rolling.observed.services[0].targetRegistrations.map((target: any) => [target.targetId, target.state]), [["10.0.0.4", "draining"], ["10.0.0.5", "healthy"]]);
for (const mode of ["unexpected_target_healthy", "expected_target_unhealthy"] as const) {
  const failed = verify(mode);
  assert.notEqual(failed.result.status, 0, `${mode} must fail closed`);
  assert.equal(failed.observed.verified, false);
  assert.equal(failed.observed.services[0].failureCode, "DG_ECS_STABILITY_FAILED");
  assert.equal(failed.observed.services[0].stage, "ecs_stability");
  assert.match(failed.observed.services[0].failureMarker, new RegExp(`DG_FAILURE serviceId=${serviceId}`));
  assert.ok(Array.isArray(failed.observed.services[0].diagnostics.targetHealth), "bounded structured ALB diagnostics remain in the failed verifier evidence");
}
const timedOut = verify("target_timeout");
assert.notEqual(timedOut.result.status, 0, "target-health convergence timeout must fail terminal verification");
assert.match(timedOut.result.stderr, new RegExp(`DG_FAILURE serviceId=${serviceId} code=DG_ECS_STABILITY_FAILED stage=ecs_stability`));
const emptyDiagnostics = verify("empty_diagnostics");
assert.notEqual(emptyDiagnostics.result.status, 0);
assert.match(emptyDiagnostics.result.stderr, /DG_ECS_DIAGNOSTICS/);
assert.match(emptyDiagnostics.result.stderr, new RegExp(`DG_FAILURE serviceId=${serviceId} code=DG_ECS_STABILITY_FAILED stage=ecs_stability`));
assert.doesNotMatch(emptyDiagnostics.result.stderr, /Cannot iterate over null|jq: error/, "empty stopped tasks, containers, ECS events, targets, and log events remain null-safe");

const albConverged = verify("alb_provisioning_then_active");
assert.equal(albConverged.result.status, 0, albConverged.result.stderr);
const albTimedOut = verify("alb_timeout");
assert.notEqual(albTimedOut.result.status, 0);
assert.equal(albTimedOut.observed.services[0].failureCode, "DG_ALB_NOT_ACTIVE");
assert.equal(albTimedOut.observed.services[0].diagnostics.classification, "TRANSIENT_TIMEOUT");
const deadlineStarted = Date.now();
const albDeadline = verify("alb_elapsed_deadline");
const deadlineElapsed = Date.now() - deadlineStarted;
assert.notEqual(albDeadline.result.status, 0);
assert.equal(albDeadline.observed.services[0].failureCode, "DG_ALB_NOT_ACTIVE");
assert.ok(deadlineElapsed < 1900, `overall ALB deadline must cap a longer retry interval; elapsed=${deadlineElapsed}ms`);
assert.ok(albDeadline.observed.services[0].diagnostics.elapsedSeconds <= 1, "terminal evidence records the enforced convergence deadline");
const listenerMismatch = verify("listener_mismatch");
assert.notEqual(listenerMismatch.result.status, 0);
assert.equal(listenerMismatch.observed.services[0].failureCode, "DG_ALB_LISTENER_MISMATCH");
assert.equal(listenerMismatch.observed.services[0].diagnostics.classification, "FATAL");

const dnsConverged = verify("dns_unresolved_then_resolves");
assert.equal(dnsConverged.result.status, 0, dnsConverged.result.stderr);
assert.equal(dnsConverged.observed.services[0].publicProbe.dnsAttempts, 2);
const dnsTimedOut = verify("dns_timeout");
assert.notEqual(dnsTimedOut.result.status, 0);
assert.equal(dnsTimedOut.observed.services[0].failureCode, "DG_PUBLIC_DNS_UNRESOLVED");
assert.equal(dnsTimedOut.observed.services[0].diagnostics.attempts, 3);

for (const mode of ["connection_refused_then_success", "connection_reset_then_success", "connection_timeout_then_success", "alb_502_then_success", "alb_503_then_success", "alb_504_then_success"] as const) {
  const transient = verify(mode);
  assert.equal(transient.result.status, 0, `${mode} must converge: ${transient.result.stderr}`);
  assert.equal(transient.observed.services[0].publicProbe.attemptCount, 2);
}
for (const mode of ["persistent_alb_502", "persistent_alb_503", "persistent_alb_504"] as const) {
  const persistent = verify(mode);
  assert.notEqual(persistent.result.status, 0, `${mode} must fail closed after the bounded policy`);
  assert.equal(persistent.observed.services[0].failureCode, "DG_PUBLIC_REACHABILITY_FAILED");
  assert.equal(persistent.observed.services[0].diagnostics.attemptCount, 3);
}
const connectionFailure = verify("persistent_connection_failure");
assert.notEqual(connectionFailure.result.status, 0);
assert.equal(connectionFailure.observed.services[0].failureCode, "DG_PUBLIC_CONNECTION_FAILED");
assert.equal(connectionFailure.observed.services[0].diagnostics.attemptCount, 3);
assert.doesNotMatch(JSON.stringify(connectionFailure.observed), /top-secret/);
assert.match(JSON.stringify(connectionFailure.observed), /\[REDACTED\]/);

const cloudMapConverged = verify("cloud_map_empty_then_registered");
assert.equal(cloudMapConverged.result.status, 0, cloudMapConverged.result.stderr);
assert.equal(cloudMapConverged.observed.databaseVerified, true);
assert.equal(cloudMapConverged.observed.services[0].managedDatabase.attached, true);
const cloudMapTimedOut = verify("cloud_map_timeout");
assert.notEqual(cloudMapTimedOut.result.status, 0);
assert.equal(cloudMapTimedOut.observed.services[0].failureCode, "DG_CLOUD_MAP_REGISTRATION_TIMEOUT");
assert.equal(cloudMapTimedOut.observed.services[0].diagnostics.classification, "TRANSIENT_TIMEOUT");
assert.equal(cloudMapTimedOut.observed.services[0].diagnostics.attempts, 3);

console.log("TERMINAL_RUNTIME_BINDINGS=PASS EXACT_ENV=1 EXACT_SECRET_VALUE_FROM=1 TASK_ENI_TRANSPORT_READINESS=1 HTTP_200_404_500_APPLICATION_ERRORS_LIVE=1 TEMPLATE_EXCEPTION_LIVE=1 BUSINESS_ERROR_LIVE=1 FAILURE_PROPAGATION=1 NULL_SAFE_DIAGNOSTICS=1 TARGET_HEALTH_CONVERGENCE=1 ROLLING_DRAINING_ALLOWED=1 UNEXPECTED_ACTIVE_TARGET_REJECTED=1 ALB_CONVERGENCE=1 LISTENER_IDENTITY=1 DNS_CONVERGENCE=1 PUBLIC_TRANSPORT_CONVERGENCE=1 PERSISTENT_GATEWAY_FAILURE_REJECTED=1 CLOUD_MAP_CONVERGENCE=1 BOUNDED_DIAGNOSTICS=1");
