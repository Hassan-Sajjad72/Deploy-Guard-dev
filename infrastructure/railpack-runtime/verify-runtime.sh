#!/usr/bin/env bash
set -euo pipefail

outputs="${1:-.deployguard/terraform-outputs.json}"
runtime="${2:-.deployguard/runtime.json}"
evidence="${3:-.deployguard/aws-runtime-verification.json}"
mkdir -p "$(dirname "$evidence")"
printf '[]' > "$evidence"

append_outcome() {
  local service_id="$1" verified="$2" code="${3:-}" summary="${4:-}"
  local outcome
  outcome="$(jq -cn --arg serviceId "$service_id" --argjson verified "$verified" --arg code "$code" --arg summary "$summary" --arg checkedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" '{serviceId:$serviceId,verified:$verified,checkedAt:$checkedAt} + (if $code == "" then {} else {failureCode:$code,summary:$summary} end)')"
  jq --arg id "$service_id" --argjson outcome "$outcome" '[.[] | select(.serviceId != $id)] + [$outcome]' "$evidence" > "$evidence.next"
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
  jq -cn --arg diagnosticCode AWS_RUNTIME_CONFIGURATION_MISMATCH --arg summary "$message" '{diagnosticCode:$diagnosticCode,summary:$summary}' \
    | sed 's/^/DG_ECS_DIAGNOSTICS /' >&2
  echo "DG_FAILURE serviceId=$service_id code=DG_AWS_RUNTIME_CONFIGURATION_FAILED stage=aws_runtime_verification" >&2
  append_outcome "$service_id" false DG_AWS_RUNTIME_CONFIGURATION_FAILED "$message"
  exit 1
}

provider_failure() {
  local service_id="$1" detail="$2"
  if grep -Eqi 'AccessDenied|not authorized|UnauthorizedOperation' <<<"$detail"; then
    printf '%s\n' "$detail" | sanitize >&2
    echo "DG_FAILURE serviceId=$service_id code=DG_AWS_AUTHORIZATION_FAILED stage=aws_runtime_verification" >&2
    append_outcome "$service_id" false DG_AWS_AUTHORIZATION_FAILED "AWS authorization failed during terminal reconciliation."
  else
    printf '%s\n' "$detail" | sanitize >&2
    echo "DG_FAILURE serviceId=$service_id code=DG_AWS_PROVIDER_FAILED stage=aws_runtime_verification" >&2
    append_outcome "$service_id" false DG_AWS_PROVIDER_FAILED "AWS provider observation failed during terminal reconciliation."
  fi
  exit 1
}

ecs_diagnostics() {
  local service_id="$1" cluster="$2" service_name="$3" target_group="$4" log_group="$5"
  local stopped_arns tasks service_description target_health logs start_ms
  stopped_arns="$(aws ecs list-tasks --cluster "$cluster" --service-name "$service_name" --desired-status STOPPED --max-results 20 --output json 2>/dev/null || printf '{"taskArns":[]}')"
  tasks='{"tasks":[]}'
  if [ "$(jq '.taskArns | length' <<<"$stopped_arns")" -gt 0 ]; then
    tasks="$(aws ecs describe-tasks --cluster "$cluster" --tasks $(jq -r '.taskArns[]' <<<"$stopped_arns") --output json 2>/dev/null || printf '{"tasks":[]}')"
  fi
  service_description="$(aws ecs describe-services --cluster "$cluster" --services "$service_name" --output json 2>/dev/null || printf '{"services":[]}')"
  target_health="$(aws elbv2 describe-target-health --target-group-arn "$target_group" --output json 2>/dev/null || printf '{"TargetHealthDescriptions":[]}')"
  start_ms="$(( $(date +%s) * 1000 - 900000 ))"
  logs="$(aws logs filter-log-events --log-group-name "$log_group" --start-time "$start_ms" --limit 50 --output json 2>/dev/null || printf '{"events":[]}')"
  jq -cn \
    --argjson tasks "$tasks" --argjson service "$service_description" --argjson target "$target_health" --argjson logs "$logs" '
      ($tasks.tasks | sort_by(.stoppedAt // "") | last // {}) as $task |
      ($task.containers | map(select(.name == "application")) | first // $task.containers[0] // {}) as $container |
      {diagnosticCode:"ECS_STABILITY_FAILED",stopCode:($task.stopCode//null),stoppedTaskReason:($task.stoppedReason//null),containerExitCode:($container.exitCode//null),containerReason:($container.reason//null),taskEvents:([$service.services[0].events[0:12][]?.message][0:12]),targetHealth:([$target.TargetHealthDescriptions[0:20][]?|{state:(.TargetHealth.State//null),reason:(.TargetHealth.Reason//null),description:(.TargetHealth.Description//null)}]),logLines:([$logs.events[-25:][]?.message][0:25])}' \
    | sanitize | sed 's/^/DG_ECS_DIAGNOSTICS /' >&2
  echo "DG_FAILURE serviceId=$service_id code=DG_ECS_STABILITY_FAILED stage=ecs_stability" >&2
  append_outcome "$service_id" false DG_ECS_STABILITY_FAILED "ECS service stability or runtime-process verification failed."
  exit 1
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
  local service="$1" service_id deployed expected service_name target_group log_group service_description task_definition_arn task_definition expected_image
  local database expected_environment expected_secrets application_sg security_group running tasks target_health check
  service_id="$(jq -r '.key' <<<"$service")"; deployed="$(jq -c '.value' <<<"$service")"
  expected="$(jq -c --arg id "$service_id" '.services[] | select(.serviceId == $id)' "$runtime")"
  service_name="$(jq -r '.ecs_service_name' <<<"$deployed")"; target_group="$(jq -r '.alb_target_group_arn' <<<"$deployed")"; log_group="$(jq -r '.cloudwatch_log_group_name' <<<"$deployed")"
  service_description="$(aws ecs describe-services --cluster "$cluster" --services "$service_name" --output json 2>&1)" || provider_failure "$service_id" "$service_description"
  task_definition_arn="$(jq -r '.task_definition_arn' <<<"$deployed")"
  task_definition="$(aws ecs describe-task-definition --task-definition "$task_definition_arn" --output json 2>&1)" || provider_failure "$service_id" "$task_definition"
  expected_image="$(jq -r '.image' <<<"$deployed")"
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
  jq -e --arg task "$task_definition_arn" --argjson subnets "$expected_subnets" '
    .services[0].status == "ACTIVE" and .services[0].taskDefinition == $task and (.services[0].networkConfiguration.awsvpcConfiguration.subnets | sort) == $subnets and (.services[0].networkConfiguration.awsvpcConfiguration.securityGroups | length > 0)
  ' <<<"$service_description" >/dev/null || configuration_failure "$service_id" "ECS service identity or VPC/subnet configuration does not match the expected runtime."
  jq -e --arg image "$expected_image" --arg log "$log_group" --argjson secrets "$expected_secrets" --argjson environment "$expected_environment" '
    (.taskDefinition.containerDefinitions | map(select(.name == "application")) | first) as $app |
    $app.image == $image and ($app.portMappings | any(.containerPort == 8080)) and $app.logConfiguration.options["awslogs-group"] == $log
    and ([$app.secrets[]? | {key:.name,value:.valueFrom}] | from_entries) == $secrets
    and ([$app.environment[]? | {key:.name,value:.value}] | from_entries) == $environment
  ' <<<"$task_definition" >/dev/null || configuration_failure "$service_id" "Task definition image, port, log, environment, or Secrets Manager injection does not match the immutable runtime."
  application_sg="$(jq -r '.security_group_id' <<<"$deployed")"
  security_group="$(aws ec2 describe-security-groups --group-ids "$application_sg" --output json 2>&1)" || provider_failure "$service_id" "$security_group"
  jq -e --arg vpc "$(jq -r '.vpc_id' "$outputs")" '.SecurityGroups[0].VpcId == $vpc' <<<"$security_group" >/dev/null || configuration_failure "$service_id" "Application security group is not in the expected VPC."
  aws ecs wait services-stable --cluster "$cluster" --services "$service_name" || ecs_diagnostics "$service_id" "$cluster" "$service_name" "$target_group" "$log_group"
  running="$(aws ecs list-tasks --cluster "$cluster" --service-name "$service_name" --desired-status RUNNING --output json 2>&1)" || provider_failure "$service_id" "$running"
  jq -e '.taskArns | length > 0' <<<"$running" >/dev/null || ecs_diagnostics "$service_id" "$cluster" "$service_name" "$target_group" "$log_group"
  tasks="$(aws ecs describe-tasks --cluster "$cluster" --tasks $(jq -r '.taskArns[]' <<<"$running") --output json 2>&1)" || provider_failure "$service_id" "$tasks"
  jq -e --arg task "$task_definition_arn" 'all(.tasks[]; .lastStatus == "RUNNING" and .taskDefinitionArn == $task and any(.containers[]; .name == "application" and .lastStatus == "RUNNING"))' <<<"$tasks" >/dev/null || ecs_diagnostics "$service_id" "$cluster" "$service_name" "$target_group" "$log_group"
  target_health="$(aws elbv2 describe-target-health --target-group-arn "$target_group" --output json 2>&1)" || provider_failure "$service_id" "$target_health"
  jq -e '.TargetHealthDescriptions | length > 0 and all(.[]; .TargetHealth.State == "healthy")' <<<"$target_health" >/dev/null || ecs_diagnostics "$service_id" "$cluster" "$service_name" "$target_group" "$log_group"
  curl --show-error --silent --retry 20 --retry-delay 3 --retry-connrefused --output /dev/null "$(jq -r '.public_url' <<<"$deployed")" || { echo "DG_FAILURE serviceId=$service_id code=DG_PUBLIC_REACHABILITY_FAILED stage=public_health" >&2; append_outcome "$service_id" false DG_PUBLIC_REACHABILITY_FAILED "The verified service endpoint is not publicly reachable."; exit 1; }
  check="$(jq -cn --arg serviceId "$service_id" --arg checkedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --argjson running "$(jq '.taskArns | length' <<<"$running")" --argjson targets "$(jq '[.TargetHealthDescriptions[] | .TargetHealth.State]' <<<"$target_health")" '{serviceId:$serviceId,verified:true,ecsTasksRunning:$running,targetHealth:$targets,taskDefinition:true,secretsInjection:true,vpcConnectivity:true,publicReachability:true,checkedAt:$checkedAt}')"
  jq --argjson check "$check" '. + [$check]' "$evidence" > "$evidence.next"; mv "$evidence.next" "$evidence"
}

while IFS= read -r service; do
  service_id="$(jq -r '.key' <<<"$service")"
  if [ "$database_failed" = true ] && [ "$service_id" = "$database_id" ]; then
    continue
  fi
  (verify_service "$service") || true
done < <(jq -c '.services | to_entries[]' "$outputs")

jq -n --arg contractVersion deployguard.aws-runtime-verification/v1 --arg verifiedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --argjson services "$(cat "$evidence")" --argjson databaseVerified "$([ -n "$database_service" ] && [ "$database_failed" = false ] && echo true || echo false)" '{contractVersion:$contractVersion,verified:($services | all(.verified == true)),verifiedAt:$verifiedAt,services:$services,databaseVerified:$databaseVerified}' > "$evidence.next"
mv "$evidence.next" "$evidence"
