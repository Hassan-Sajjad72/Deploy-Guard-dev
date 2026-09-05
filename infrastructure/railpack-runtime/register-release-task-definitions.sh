#!/usr/bin/env bash
set -euo pipefail

# Register one immutable ECS revision per application service without asking
# Terraform to mutate an already-established service topology.  The active
# task definition supplies the Terraform-owned task shape; only the
# DeployGuard-owned immutable application release fields are replaced.
outputs="${1:?Terraform outputs path is required}"
runtime="${2:?runtime configuration path is required}"
artifacts="${3:?service artifacts path is required}"
release_action="${4:-deploy}"

failure() {
  echo "DG_FAILURE code=DG_ECS_RELEASE_ONLY_FAILED stage=ecs_release_only message=$1" >&2
  exit 1
}

for file in "$outputs" "$runtime" "$artifacts"; do
  if [ ! -s "$file" ] || ! jq -e . "$file" >/dev/null 2>&1; then
    failure invalid_release_only_input
  fi
done

case "$release_action" in
  deploy|rollback) ;;
  *) failure invalid_release_only_action ;;
esac

cluster="$(jq -r '.ecs_cluster_name // empty' "$outputs")"
[ -n "$cluster" ] || failure missing_ecs_cluster
mkdir -p .deployguard/release-only
cp "$outputs" .deployguard/release-only/terraform-outputs.json

while IFS= read -r artifact; do
  service_id="$(jq -r '.serviceId' <<<"$artifact")"
  image="$(jq -r '.image' <<<"$artifact")"
  service_port="$(jq -r '.servicePort' <<<"$artifact")"
  runtime_config_revision_id="$(jq -r '.runtimeConfigRevisionId' <<<"$artifact")"
  expected="$(jq -c --arg id "$service_id" '.services[] | select(.serviceId == $id)' "$runtime")"
  deployed="$(jq -c --arg id "$service_id" '.services[$id] // empty' .deployguard/release-only/terraform-outputs.json)"
  [ -n "$expected" ] && [ -n "$deployed" ] || failure missing_service_release_identity
  [ "$(jq -r '.servicePort' <<<"$expected")" = "$service_port" ] || failure service_port_changed_requires_terraform
  [ "$(jq -r '.runtimeConfigRevisionId' <<<"$expected")" = "$runtime_config_revision_id" ] || failure runtime_revision_mismatch
  service_name="$(jq -r '.ecs_service_name // empty' <<<"$deployed")"
  [ -n "$service_name" ] || failure missing_ecs_service

  service_description="$(aws ecs describe-services --cluster "$cluster" --services "$service_name" --output json 2>&1)" || failure ecs_service_lookup_failed
  current_task_definition="$(jq -r '.services[0].taskDefinition // empty' <<<"$service_description")"
  desired_count="$(jq -r '.services[0].desiredCount // empty' <<<"$service_description")"
  [ -n "$current_task_definition" ] && [ "$desired_count" = "1" ] || failure inactive_service_requires_terraform
  task_description="$(aws ecs describe-task-definition --task-definition "$current_task_definition" --include TAGS --output json 2>&1)" || failure task_definition_lookup_failed
  transport_probe_port="$(jq -r '.transport_probe_port' <<<"$deployed")"
  jq -e --argjson applicationPort "$service_port" --argjson probePort "$transport_probe_port" '
    (.taskDefinition.family | type == "string" and length > 0)
    and ([.taskDefinition.containerDefinitions[]? | select(.name == "application")] | length == 1)
    and ([.taskDefinition.containerDefinitions[]? | select(.name == "deployguard-transport-probe")] | length == 1)
    and ([.taskDefinition.containerDefinitions[] | select(.name == "application") | .portMappings[]? | select(.containerPort == $applicationPort and .hostPort == $applicationPort)] | length > 0)
    and ([.taskDefinition.containerDefinitions[] | select(.name == "deployguard-transport-probe") | .portMappings[]? | select(.containerPort == $probePort and .hostPort == $probePort)] | length > 0)
  ' <<<"$task_description" >/dev/null || failure active_task_definition_topology_mismatch

  database="$(jq -c '.database // null' .deployguard/release-only/terraform-outputs.json)"
  database_secret_version="$(jq -r '.secret_version_id // empty' <<<"$database")"
  if [ "$(jq -r '.databaseAttached' <<<"$expected")" = true ]; then
    [ -n "$database_secret_version" ] || failure missing_database_secret_version
    if [ "$release_action" = rollback ]; then
      historical_database_secret_version="$(jq -r '.managedDatabase.secretVersionId // empty' <<<"$expected")"
      [ -n "$historical_database_secret_version" ] || failure rollback_database_secret_version_missing
      [ "$historical_database_secret_version" = "$database_secret_version" ] || failure rollback_database_secret_version_mismatch
    fi
  fi
  application_environment="$(jq -cn --argjson expected "$expected" --argjson database "$database" '
    def secret_alias: test("(PASSWORD|URL|URI)$");
    def host_alias: test("^(DB_HOST|DATABASE_HOST|POSTGRES_HOST|PGHOST|MYSQL_HOST|MONGO_HOST|MONGODB_HOST)$");
    def port_alias: test("^(DB_PORT|DATABASE_PORT|POSTGRES_PORT|PGPORT|MYSQL_PORT|MONGO_PORT|MONGODB_PORT)$");
    def user_alias: test("^(DB_USER|DATABASE_USER|POSTGRES_USER|PGUSER|MYSQL_USER|MONGO_USER|MONGODB_USER)$");
    $expected.environment + (if $expected.databaseAttached then reduce $expected.managedDatabase.aliases[] as $key ({}; if ($key|secret_alias) then . else .[$key] = (if ($key|host_alias) then $database.host elif ($key|port_alias) then ($database.port|tostring) elif ($key|user_alias) then "deployguard" else "application" end) end) else {} end) | to_entries | map({name:.key,value:.value})
  ')"
  application_secrets="$(jq -cn --argjson expected "$expected" --argjson database "$database" --arg databaseSecretVersion "$database_secret_version" '
    def secret_alias: test("(PASSWORD|URL|URI)$");
    def url_alias: test("^(DATABASE_URL|POSTGRES_URL|POSTGRESQL_URL|MYSQL_URL|MONGO_URI|MONGO_URL|MONGODB_URI)$");
    $expected.secretReferences + (if $expected.databaseAttached then reduce $expected.managedDatabase.aliases[] as $key ({}; if ($key|secret_alias) then .[$key] = ($database.credentials_secret_arn + ":" + (if ($key|url_alias) then "url" else "password" end) + "::" + $databaseSecretVersion) else . end) else {} end) | to_entries | map({name:.key,valueFrom:.value})
  ')"
  if [ "$release_action" = rollback ]; then
    task_definition_arn="$(jq -r '.rollbackTaskDefinitionArn // empty' <<<"$expected")"
    [[ "$task_definition_arn" =~ ^arn:aws:ecs:[a-z0-9-]+:[0-9]{12}:task-definition/[A-Za-z0-9_-]+:[0-9]+$ ]] || failure rollback_requires_immutable_task_definition
    task_description="$(aws ecs describe-task-definition --task-definition "$task_definition_arn" --output json 2>&1)" || failure rollback_task_definition_lookup_failed
    jq -e --arg image "$image" --argjson environment "$application_environment" --argjson secrets "$application_secrets" --argjson applicationPort "$service_port" --argjson probePort "$transport_probe_port" '
      ([.taskDefinition.containerDefinitions[] | select(.name == "application")] | first) as $application |
      ([.taskDefinition.containerDefinitions[] | select(.name == "deployguard-transport-probe")] | first) as $probe |
      $application.image == $image
      and ([$application.environment[]? | {key:.name,value:.value}] | from_entries) == ($environment | map({key:.name,value:.value}) | from_entries)
      and ([$application.secrets[]? | {key:.name,value:.valueFrom}] | from_entries) == ($secrets | map({key:.name,value:.valueFrom}) | from_entries)
      and ($application.portMappings | any(.containerPort == $applicationPort and .hostPort == $applicationPort))
      and ($probe.portMappings | any(.containerPort == $probePort and .hostPort == $probePort))
    ' <<<"$task_description" >/dev/null || failure rollback_task_definition_identity_mismatch
  else
    registration="$(jq -cn --argjson task "$task_description" --arg image "$image" --argjson environment "$application_environment" --argjson secrets "$application_secrets" --arg runtimeConfigRevisionId "$runtime_config_revision_id" '
      ($task.taskDefinition) as $definition |
      ($definition.containerDefinitions | map(if .name == "application" then .image = $image | .environment = $environment | .secrets = $secrets else . end)) as $containers |
      {family:$definition.family, taskRoleArn:$definition.taskRoleArn, executionRoleArn:$definition.executionRoleArn, networkMode:$definition.networkMode, containerDefinitions:$containers, volumes:$definition.volumes, placementConstraints:$definition.placementConstraints, requiresCompatibilities:$definition.requiresCompatibilities, cpu:$definition.cpu, memory:$definition.memory, pidMode:$definition.pidMode, ipcMode:$definition.ipcMode, proxyConfiguration:$definition.proxyConfiguration, inferenceAccelerators:$definition.inferenceAccelerators, ephemeralStorage:$definition.ephemeralStorage, runtimePlatform:$definition.runtimePlatform, tags:((($task.tags // []) | map(select(.key != "DeployGuardRuntimeConfigRevisionId"))) + [{key:"DeployGuardRuntimeConfigRevisionId",value:$runtimeConfigRevisionId}])} | with_entries(select(.value != null))
    ')"
    registration_path=".deployguard/release-only/${service_id}.task-definition.json"
    printf '%s\n' "$registration" > "$registration_path"
    registered="$(aws ecs register-task-definition --cli-input-json "file://${registration_path}" --output json 2>&1)" || failure task_definition_registration_failed
    task_definition_arn="$(jq -r '.taskDefinition.taskDefinitionArn // empty' <<<"$registered")"
    [ -n "$task_definition_arn" ] || failure registered_task_definition_missing
  fi
  aws ecs update-service --cluster "$cluster" --service "$service_name" --task-definition "$task_definition_arn" --force-new-deployment --output json >/dev/null 2>&1 || failure ecs_service_update_failed
  jq --arg id "$service_id" --arg image "$image" --arg revision "$runtime_config_revision_id" --arg task "$task_definition_arn" --argjson port "$service_port" '.services[$id] += {image:$image,runtime_config_revision_id:$revision,task_definition_arn:$task,service_port:$port}' .deployguard/release-only/terraform-outputs.json > .deployguard/release-only/terraform-outputs.next
  mv .deployguard/release-only/terraform-outputs.next .deployguard/release-only/terraform-outputs.json
done < <(jq -c '.[]' "$artifacts")

cat .deployguard/release-only/terraform-outputs.json
