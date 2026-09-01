#!/usr/bin/env bash
set -euo pipefail

outputs="${1:-.deployguard/terraform-outputs.json}"
runtime="${2:-.deployguard/runtime.json}"
evidence="${3:-.deployguard/aws-runtime-verification.json}"
mkdir -p "$(dirname "$evidence")"
printf '[]' > "$evidence"

append_outcome() {
  local service_id="$1" verified="$2" code="${3:-}" summary="${4:-}" stage="${5:-aws_runtime_verification}"
  local outcome
  outcome="$(jq -cn --arg serviceId "$service_id" --argjson verified "$verified" --arg code "$code" --arg summary "$summary" --arg stage "$stage" --arg checkedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" '{serviceId:$serviceId,verified:$verified,checkedAt:$checkedAt} + (if $code == "" then {} else {failureCode:$code,stage:$stage,failureMarker:("DG_FAILURE serviceId="+$serviceId+" code="+$code+" stage="+$stage),summary:$summary} end)')"
  jq --arg id "$service_id" --argjson outcome "$outcome" '[.[] | select(.serviceId != $id)] + [$outcome]' "$evidence" > "$evidence.next"
  mv "$evidence.next" "$evidence"
}

attach_diagnostics() {
  local service_id="$1" diagnostic="$2"
  jq --arg id "$service_id" --argjson diagnostic "$diagnostic" 'map(if .serviceId == $id then . + {diagnostics:$diagnostic} else . end)' "$evidence" > "$evidence.next"
  mv "$evidence.next" "$evidence"
}

sanitize() {
  sed -E \
    -e 's/(AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9_]{20,})/[REDACTED]/g' \
    -e 's/((password|passwd|token|secret|api[_-]?key|authorization)[[:space:]]*[:=][[:space:]]*)[^[:space:]",}]+/\1[REDACTED]/Ig' \
    -e 's#([a-z]+://[^:/[:space:]]+):[^@[:space:]]+@#\1:[REDACTED]@#Ig' \
    | tr -cd '\11\12\15\40-\176' | tail -c 12000
}

configuration_failure() {
  local service_id="$1" message="$2"
  echo "DG_FAILURE serviceId=$service_id code=DG_AWS_RUNTIME_CONFIGURATION_FAILED stage=aws_runtime_verification" >&2
  append_outcome "$service_id" false DG_AWS_RUNTIME_CONFIGURATION_FAILED "$message" aws_runtime_verification
  jq -cn --arg diagnosticCode AWS_RUNTIME_CONFIGURATION_MISMATCH --arg summary "$message" '{diagnosticCode:$diagnosticCode,summary:$summary}' \
    | sed 's/^/DG_ECS_DIAGNOSTICS /' >&2 || true
  exit 1
}

provider_failure() {
  local service_id="$1" detail="$2"
  if grep -Eqi 'AccessDenied|not authorized|UnauthorizedOperation' <<<"$detail"; then
    printf '%s\n' "$detail" | sanitize >&2
    echo "DG_FAILURE serviceId=$service_id code=DG_AWS_AUTHORIZATION_FAILED stage=aws_runtime_verification" >&2
    append_outcome "$service_id" false DG_AWS_AUTHORIZATION_FAILED "AWS authorization failed during terminal reconciliation." aws_runtime_verification
  else
    printf '%s\n' "$detail" | sanitize >&2
    echo "DG_FAILURE serviceId=$service_id code=DG_AWS_PROVIDER_FAILED stage=aws_runtime_verification" >&2
    append_outcome "$service_id" false DG_AWS_PROVIDER_FAILED "AWS provider observation failed during terminal reconciliation." aws_runtime_verification
  fi
  exit 1
}

ecs_diagnostics() {
  local service_id="$1" cluster="$2" service_name="$3" target_group="$4" log_group="$5"
  local stopped_arns tasks service_description target_health logs start_ms diagnostic
  echo "DG_FAILURE serviceId=$service_id code=DG_ECS_STABILITY_FAILED stage=ecs_stability" >&2
  append_outcome "$service_id" false DG_ECS_STABILITY_FAILED "ECS service stability or runtime-process verification failed." ecs_stability
  stopped_arns="$(aws ecs list-tasks --cluster "$cluster" --service-name "$service_name" --desired-status STOPPED --max-results 20 --output json 2>/dev/null || printf '{"taskArns":[]}')"
  tasks='{"tasks":[]}'
  if [ "$(jq '.taskArns | length' <<<"$stopped_arns")" -gt 0 ]; then
    tasks="$(aws ecs describe-tasks --cluster "$cluster" --tasks $(jq -r '.taskArns[]' <<<"$stopped_arns") --output json 2>/dev/null || printf '{"tasks":[]}')"
  fi
  service_description="$(aws ecs describe-services --cluster "$cluster" --services "$service_name" --output json 2>/dev/null || printf '{"services":[]}')"
  target_health='{"TargetHealthDescriptions":[]}'
  if [ -n "$target_group" ]; then
    target_health="$(aws elbv2 describe-target-health --target-group-arn "$target_group" --output json 2>/dev/null || printf '{"TargetHealthDescriptions":[]}')"
  fi
  start_ms="$(( $(date +%s) * 1000 - 900000 ))"
  logs='{"events":[]}'
  if [ -n "$log_group" ]; then
    logs="$(aws logs filter-log-events --log-group-name "$log_group" --start-time "$start_ms" --limit 50 --output json 2>/dev/null || printf '{"events":[]}')"
  fi
  diagnostic="$(jq -cn \
    --argjson tasks "$tasks" --argjson service "$service_description" --argjson target "$target_health" --argjson logs "$logs" '
      (($tasks.tasks // []) | sort_by(.stoppedAt // "") | last // {}) as $task |
      (($task.containers // []) | map(select(.name == "application")) | first // (($task.containers // [])[0]) // {}) as $container |
      {diagnosticCode:"ECS_STABILITY_FAILED",stopCode:($task.stopCode//null),stoppedTaskReason:($task.stoppedReason//null),containerExitCode:($container.exitCode//null),containerReason:($container.reason//null),taskEvents:((($service.services // [])[0].events // [])[0:12] | map(.message // null)),targetHealth:(($target.TargetHealthDescriptions // [])[0:20] | map({targetId:(.Target.Id//null),port:(.Target.Port//null),state:(.TargetHealth.State//null),reason:(.TargetHealth.Reason//null),description:(.TargetHealth.Description//null)})),logLines:(($logs.events // [])[-25:] | map(.message // null))}' 2>/dev/null || printf '{"diagnosticCode":"ECS_STABILITY_FAILED","diagnosticsUnavailable":true}')"
  diagnostic="$(printf '%s\n' "$diagnostic" | sanitize)"
  jq -e 'type == "object"' <<<"$diagnostic" >/dev/null 2>&1 || diagnostic='{"diagnosticCode":"ECS_STABILITY_FAILED","diagnosticsUnavailable":true}'
  attach_diagnostics "$service_id" "$diagnostic" || true
  printf '%s\n' "$diagnostic" | sed 's/^/DG_ECS_DIAGNOSTICS /' >&2 || true
  exit 1
}

wait_for_target_health() {
  local service_id="$1" target_group="$2" expected_targets="$3" attempt detail
  local max_attempts="${DEPLOYGUARD_TARGET_HEALTH_MAX_ATTEMPTS:-20}"
  local interval_seconds="${DEPLOYGUARD_TARGET_HEALTH_INTERVAL_SECONDS:-6}"
  target_health='{"TargetHealthDescriptions":[]}'
  for ((attempt=1; attempt<=max_attempts; attempt++)); do
    detail="$(aws elbv2 describe-target-health --target-group-arn "$target_group" --output json 2>&1)" || provider_failure "$service_id" "$detail"
    target_health="$detail"
    if jq -e --argjson expected "$expected_targets" '
      ($expected | sort | unique) as $current |
      [.TargetHealthDescriptions[]? | {id:.Target.Id,state:.TargetHealth.State}] as $observed |
      ($current | length > 0)
      and all($current[]; . as $id | any($observed[]; .id == $id and .state == "healthy"))
      and all($observed[]; (.id as $id | ($current | index($id)) != null) or .state == "draining")
    ' <<<"$target_health" >/dev/null; then
      return 0
    fi
    [ "$attempt" -eq "$max_attempts" ] || sleep "$interval_seconds"
  done
  return 1
}

cluster="$(jq -r '.ecs_cluster_name' "$outputs")"
expected_subnets="$(jq -c 'map(gsub("^\\s+|\\s+$"; "")) | sort' <<<"$(jq -c '.public_subnet_ids // []' "$outputs")")"

database_service="$(jq -r '.database.ecs_service_name // empty' "$outputs")"
database_id="$(jq -r '.database.attached_service_id // empty' "$outputs")"
verify_database() {
  database_id="$(jq -r '.database.attached_service_id' "$outputs")"
  aws ecs wait services-stable --cluster "$cluster" --services "$database_service" || ecs_diagnostics "$database_id" "$cluster" "$database_service" "" "$(jq -r '.database.cloudwatch_log_group_name' "$outputs")"
  database_description="$(aws ecs describe-services --cluster "$cluster" --services "$database_service" --output json 2>&1)" || provider_failure "$database_id" "$database_description"
  database_task_definition="$(jq -r '.database.task_definition_arn' "$outputs")"
  database_task="$(aws ecs list-tasks --cluster "$cluster" --service-name "$database_service" --desired-status RUNNING --output json 2>&1)" || provider_failure "$database_id" "$database_task"
  cloud_map_service="$(jq -r '.database.cloud_map_service_id' "$outputs")"
  cloud_map="$(aws servicediscovery get-service --id "$cloud_map_service" --output json 2>&1)" || provider_failure "$database_id" "$cloud_map"
  instances="$(aws servicediscovery list-instances --service-id "$cloud_map_service" --output json 2>&1)" || provider_failure "$database_id" "$instances"
  database_sg="$(jq -r '.database.security_group_id' "$outputs")"
  application_sg="$(jq -r '.services[.database.attached_service_id].security_group_id' "$outputs")"
  security_group="$(aws ec2 describe-security-groups --group-ids "$database_sg" --output json 2>&1)" || provider_failure "$database_id" "$security_group"
  database_port="$(jq -r '.database.port' "$outputs")"
  jq -e --arg task "$database_task_definition" --arg registry "$(jq -r '.database.cloud_map_service_arn' "$outputs")" '
    .services[0].status == "ACTIVE" and .services[0].taskDefinition == $task and (.services[0].serviceRegistries | map(.registryArn) | index($registry) != null)
  ' <<<"$database_description" >/dev/null || configuration_failure "$database_id" "Managed database ECS or Cloud Map runtime identity does not match Terraform."
  jq -e '.taskArns | length > 0' <<<"$database_task" >/dev/null || configuration_failure "$database_id" "Managed database has no running ECS task."
  jq -e '.Service.Type == "DNS_HTTP"' <<<"$cloud_map" >/dev/null || configuration_failure "$database_id" "Cloud Map service is not DNS-enabled."
  jq -e '.Instances | length > 0' <<<"$instances" >/dev/null || configuration_failure "$database_id" "Cloud Map has no registered managed-database instance."
  jq -e --arg vpc "$(jq -r '.vpc_id' "$outputs")" --arg application "$application_sg" --argjson port "$database_port" '
    .SecurityGroups[0].VpcId == $vpc and any(.SecurityGroups[0].IpPermissions[]; .FromPort == $port and .ToPort == $port and any(.UserIdGroupPairs[]; .GroupId == $application))
  ' <<<"$security_group" >/dev/null || configuration_failure "$database_id" "Managed database security group does not admit only its attached application service on the database port."
}

database_failed=false
if [ -n "$database_service" ] && ! (verify_database); then
  database_failed=true
fi

verify_service() {
  local service="$1" service_id deployed expected service_name target_group log_group service_description task_definition_arn task_definition expected_image expected_port
  local database expected_environment expected_secrets managed_database application_sg alb_sg security_group target_group_description running tasks target_health expected_targets check
  service_id="$(jq -r '.key' <<<"$service")"; deployed="$(jq -c '.value' <<<"$service")"
  expected="$(jq -c --arg id "$service_id" '.services[] | select(.serviceId == $id)' "$runtime")"
  service_name="$(jq -r '.ecs_service_name' <<<"$deployed")"; target_group="$(jq -r '.alb_target_group_arn' <<<"$deployed")"; log_group="$(jq -r '.cloudwatch_log_group_name' <<<"$deployed")"
  service_description="$(aws ecs describe-services --cluster "$cluster" --services "$service_name" --output json 2>&1)" || provider_failure "$service_id" "$service_description"
  task_definition_arn="$(jq -r '.task_definition_arn' <<<"$deployed")"
  task_definition="$(aws ecs describe-task-definition --task-definition "$task_definition_arn" --output json 2>&1)" || provider_failure "$service_id" "$task_definition"
  expected_image="$(jq -r '.image' <<<"$deployed")"
  expected_port="$(jq -r '.servicePort' <<<"$expected")"
  database="$(jq -c '.database // null' "$outputs")"
  expected_environment="$(jq -cn --argjson expected "$expected" --argjson database "$database" '
    def secret_alias: test("(PASSWORD|URL|URI)$");
    def host_alias: test("^(DB_HOST|DATABASE_HOST|POSTGRES_HOST|PGHOST|MYSQL_HOST|MONGO_HOST|MONGODB_HOST)$");
    def port_alias: test("^(DB_PORT|DATABASE_PORT|POSTGRES_PORT|PGPORT|MYSQL_PORT|MONGO_PORT|MONGODB_PORT)$");
    def user_alias: test("^(DB_USER|DATABASE_USER|POSTGRES_USER|PGUSER|MYSQL_USER|MONGO_USER|MONGODB_USER)$");
    $expected.environment + (if $expected.databaseAttached then reduce $expected.managedDatabase.aliases[] as $key ({}; if ($key|secret_alias) then . else .[$key] = (if ($key|host_alias) then $database.host elif ($key|port_alias) then ($database.port|tostring) elif ($key|user_alias) then "deployguard" else "application" end) end) else {} end)')"
  expected_secrets="$(jq -cn --argjson expected "$expected" --argjson database "$database" '
    def secret_alias: test("(PASSWORD|URL|URI)$");
    def url_alias: test("^(DATABASE_URL|POSTGRES_URL|POSTGRESQL_URL|MYSQL_URL|MONGO_URI|MONGO_URL|MONGODB_URI)$");
    $expected.secretReferences + (if $expected.databaseAttached then reduce $expected.managedDatabase.aliases[] as $key ({}; if ($key|secret_alias) then .[$key] = ($database.credentials_secret_arn + ":" + (if ($key|url_alias) then "url" else "password" end) + "::" + $database.secret_version_id) else . end) else {} end)')"
  managed_database="$(jq -cn --argjson expected "$expected" --argjson database "$database" '
    if $expected.databaseAttached then {
      attached:true,
      attachedServiceId:$database.attached_service_id,
      engine:$database.engine,
      aliases:$expected.managedDatabase.aliases,
      credentialsSecretArn:$database.credentials_secret_arn,
      secretVersionId:$database.secret_version_id
    } else {attached:false,attachedServiceId:null,engine:null,aliases:[],credentialsSecretArn:null,secretVersionId:null} end')"
  jq -e --arg task "$task_definition_arn" --arg target "$target_group" --argjson port "$expected_port" --argjson subnets "$expected_subnets" '
    .services[0].status == "ACTIVE" and .services[0].taskDefinition == $task and (.services[0].networkConfiguration.awsvpcConfiguration.subnets | sort) == $subnets and (.services[0].networkConfiguration.awsvpcConfiguration.securityGroups | length > 0)
    and any(.services[0].loadBalancers[]; .targetGroupArn == $target and .containerName == "application" and .containerPort == $port)
  ' <<<"$service_description" >/dev/null || configuration_failure "$service_id" "ECS service identity or VPC/subnet configuration does not match the expected runtime."
  jq -e --arg image "$expected_image" --arg log "$log_group" --argjson port "$expected_port" --argjson secrets "$expected_secrets" --argjson environment "$expected_environment" '
    (.taskDefinition.containerDefinitions | map(select(.name == "application")) | first) as $app |
    $app.image == $image and ($app.portMappings | any(.containerPort == $port and .hostPort == $port)) and $app.logConfiguration.options["awslogs-group"] == $log
    and ([$app.secrets[]? | {key:.name,value:.valueFrom}] | from_entries) == $secrets
    and ([$app.environment[]? | {key:.name,value:.value}] | from_entries) == $environment
  ' <<<"$task_definition" >/dev/null || configuration_failure "$service_id" "Task definition image, port, log, environment, or Secrets Manager injection does not match the immutable runtime."
  application_sg="$(jq -r '.security_group_id' <<<"$deployed")"
  alb_sg="$(jq -r '.alb_security_group_id' <<<"$deployed")"
  security_group="$(aws ec2 describe-security-groups --group-ids "$application_sg" --output json 2>&1)" || provider_failure "$service_id" "$security_group"
  jq -e --arg vpc "$(jq -r '.vpc_id' "$outputs")" --arg alb "$alb_sg" --argjson port "$expected_port" '.SecurityGroups[0].VpcId == $vpc and any(.SecurityGroups[0].IpPermissions[]; .FromPort == $port and .ToPort == $port and any(.UserIdGroupPairs[]; .GroupId == $alb))' <<<"$security_group" >/dev/null || configuration_failure "$service_id" "Application security group does not admit the service ALB on the immutable service port."
  target_group_description="$(aws elbv2 describe-target-groups --target-group-arns "$target_group" --output json 2>&1)" || provider_failure "$service_id" "$target_group_description"
  jq -e --arg vpc "$(jq -r '.vpc_id' "$outputs")" --argjson port "$expected_port" '.TargetGroups[0].VpcId == $vpc and .TargetGroups[0].Port == $port and .TargetGroups[0].Protocol == "HTTP"' <<<"$target_group_description" >/dev/null || configuration_failure "$service_id" "ALB target group does not use the immutable service port."
  aws ecs wait services-stable --cluster "$cluster" --services "$service_name" || ecs_diagnostics "$service_id" "$cluster" "$service_name" "$target_group" "$log_group"
  running="$(aws ecs list-tasks --cluster "$cluster" --service-name "$service_name" --desired-status RUNNING --output json 2>&1)" || provider_failure "$service_id" "$running"
  jq -e '.taskArns | length > 0' <<<"$running" >/dev/null || ecs_diagnostics "$service_id" "$cluster" "$service_name" "$target_group" "$log_group"
  tasks="$(aws ecs describe-tasks --cluster "$cluster" --tasks $(jq -r '.taskArns[]' <<<"$running") --output json 2>&1)" || provider_failure "$service_id" "$tasks"
  jq -e --arg task "$task_definition_arn" 'all(.tasks[]; .lastStatus == "RUNNING" and .taskDefinitionArn == $task and any(.containers[]; .name == "application" and .lastStatus == "RUNNING"))' <<<"$tasks" >/dev/null || ecs_diagnostics "$service_id" "$cluster" "$service_name" "$target_group" "$log_group"
  expected_targets="$(jq -c '[.tasks[]?.attachments[]?.details[]? | select(.name == "privateIPv4Address") | .value] | sort | unique' <<<"$tasks")"
  jq -e 'length > 0' <<<"$expected_targets" >/dev/null || ecs_diagnostics "$service_id" "$cluster" "$service_name" "$target_group" "$log_group"
  wait_for_target_health "$service_id" "$target_group" "$expected_targets" || ecs_diagnostics "$service_id" "$cluster" "$service_name" "$target_group" "$log_group"
  curl --show-error --silent --retry 20 --retry-delay 3 --retry-connrefused --output /dev/null "$(jq -r '.public_url' <<<"$deployed")" || { echo "DG_FAILURE serviceId=$service_id code=DG_PUBLIC_REACHABILITY_FAILED stage=public_health" >&2; append_outcome "$service_id" false DG_PUBLIC_REACHABILITY_FAILED "The verified service endpoint is not publicly reachable." public_health; exit 1; }
  check="$(jq -cn \
    --arg serviceId "$service_id" \
    --arg checkedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --arg image "$expected_image" \
    --arg ecsServiceArn "$(jq -r '.ecs_service_arn' <<<"$deployed")" \
    --arg taskDefinitionArn "$task_definition_arn" \
    --arg targetGroupArn "$target_group" \
    --arg publicUrl "$(jq -r '.public_url' <<<"$deployed")" \
    --argjson runningTaskArns "$(jq '.taskArns' <<<"$running")" \
    --argjson targets "$(jq --argjson expected "$expected_targets" '[.TargetHealthDescriptions[] | select(.Target.Id as $id | $expected | index($id)) | .TargetHealth.State]' <<<"$target_health")" \
    --argjson targetRegistrations "$(jq '[.TargetHealthDescriptions[] | {targetId:.Target.Id,port:(.Target.Port//null),state:.TargetHealth.State}]' <<<"$target_health")" \
    --argjson environment "$expected_environment" \
    --argjson secretValueFrom "$expected_secrets" \
    --argjson managedDatabase "$managed_database" \
    --argjson runtimePort "$expected_port" \
    '{serviceId:$serviceId,verified:true,image:$image,ecsServiceArn:$ecsServiceArn,taskDefinitionArn:$taskDefinitionArn,runningTaskArns:$runningTaskArns,ecsTasksRunning:($runningTaskArns|length),runtimePort:$runtimePort,targetGroupArn:$targetGroupArn,targetHealth:$targets,targetRegistrations:$targetRegistrations,environment:$environment,secretValueFrom:$secretValueFrom,managedDatabase:$managedDatabase,publicUrl:$publicUrl,publicEndpointVerified:true,taskDefinition:true,secretsInjection:true,vpcConnectivity:true,publicReachability:true,checkedAt:$checkedAt}')"
  jq --argjson check "$check" '. + [$check]' "$evidence" > "$evidence.next"; mv "$evidence.next" "$evidence"
}

verification_failed="$database_failed"
while IFS= read -r service; do
  service_id="$(jq -r '.key' <<<"$service")"
  if [ "$database_failed" = true ] && [ "$service_id" = "$database_id" ]; then
    continue
  fi
  if ! (verify_service "$service"); then
    verification_failed=true
  fi
done < <(jq -c '.services | to_entries[]' "$outputs")

jq -n --arg contractVersion deployguard.aws-runtime-verification/v1 --arg verifiedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --argjson services "$(cat "$evidence")" --argjson databaseVerified "$([ -n "$database_service" ] && [ "$database_failed" = false ] && echo true || echo false)" '{contractVersion:$contractVersion,verified:($services | all(.verified == true)),verifiedAt:$verifiedAt,services:$services,databaseVerified:$databaseVerified}' > "$evidence.next"
mv "$evidence.next" "$evidence"

if [ "$verification_failed" = true ] || ! jq -e '.verified == true and all(.services[]; .verified == true)' "$evidence" >/dev/null; then
  exit 1
fi
