#!/usr/bin/env bash
set -euo pipefail

action="${1:?deployment action is required}"
contract_version="${2:?release contract version is required}"
source_sha="${3:?source SHA is required}"
operation_id="${4:?operation id is required}"
artifacts="${5:?service artifacts path is required}"
terraform_outputs="${6:?Terraform outputs path is required}"
runtime_evidence="${7:?AWS runtime evidence path is required}"
result="${8:?release result path is required}"

contract_failure() {
  rm -f "${result}.next"
  echo 'DG_FAILURE code=DG_WORKFLOW_CONTRACT_INVALID stage=release_evidence_validation message=terminal_release_evidence_invalid' >&2
  exit 1
}

for required in "$artifacts" "$terraform_outputs" "$runtime_evidence"; do
  [ -s "$required" ] || contract_failure
  jq -e . "$required" >/dev/null 2>&1 || contract_failure
done

jq -n \
  --arg action "$action" \
  --arg contractVersion "$contract_version" \
  --arg sourceSha "$source_sha" \
  --arg operationId "$operation_id" \
  --argjson artifacts "$(cat "$artifacts")" \
  --argjson terraform "$(cat "$terraform_outputs")" \
  --argjson awsRuntimeVerification "$(cat "$runtime_evidence")" \
  '{
    action:$action,
    contractVersion:$contractVersion,
    sourceSha:$sourceSha,
    operationId:$operationId,
    services:($artifacts | map(. as $artifact | . + ($terraform.services[.serviceId] // {}))),
    terraform:$terraform,
    awsRuntimeVerification:$awsRuntimeVerification
  }' > "${result}.next" || contract_failure

jq -e \
  --arg action "$action" \
  --arg contractVersion "$contract_version" \
  --arg sourceSha "$source_sha" \
  --arg operationId "$operation_id" '
  . as $release |
  ($release.services | map(.serviceId) | sort) as $service_ids |
  ($release.terraform.services | keys | sort) as $terraform_service_ids |
  ($release.awsRuntimeVerification.services | map(.serviceId) | sort) as $outcome_service_ids |
  .action == $action
  and .contractVersion == $contractVersion
  and .sourceSha == $sourceSha
  and .operationId == $operationId
  and ($action == "deploy" or $action == "rollback")
  and ($sourceSha | test("^[0-9a-f]{40}$"))
  and ($operationId | test("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$"))
  and (.services | type == "array" and length > 0)
  and ($service_ids | length == (unique | length))
  and ($service_ids == $terraform_service_ids)
  and (.awsRuntimeVerification.contractVersion == "deployguard.aws-runtime-verification/v1")
  and (.awsRuntimeVerification.verified == true)
  and (.awsRuntimeVerification.verifiedAt | type == "string")
  and (.awsRuntimeVerification.services | type == "array")
  and ($outcome_service_ids | length == (unique | length))
  and ($outcome_service_ids == $service_ids)
  and (all(.awsRuntimeVerification.services[]; .verified == true))
  and (.awsRuntimeVerification.databaseVerified == (if .terraform.database == null then false else true end))
  and all(.services[];
    (.serviceId | type == "string")
    and ((.servicePort | type) == "number" and (.servicePort | floor) == .servicePort and .servicePort >= 1 and .servicePort <= 65535)
    and (.runtimeConfigRevisionId | type == "string")
    and (.imageUri | type == "string")
    and (.imageDigest | test("^sha256:[0-9a-f]{64}$"))
    and (.image == (.imageUri + "@" + .imageDigest))
    and (.image == $release.terraform.services[.serviceId].image)
    and (.runtimeConfigRevisionId == $release.terraform.services[.serviceId].runtime_config_revision_id)
    and (if $action == "deploy" then
      (.builder == "railpack" or .builder == "deployguard_docker_fallback")
      and (.builderVersion | type == "string" and length > 0)
      and (.sourceSha == $sourceSha) and (.operationId == $operationId)
      and (.buildTargetRevisionId | type == "string")
      and (.buildTargetFingerprint | test("^[0-9a-f]{64}$"))
      and (.runtimeConfigFingerprint | test("^[0-9a-f]{64}$"))
      and (.localImageId | test("^sha256:[0-9a-f]{64}$"))
      and (if .builder == "railpack" then
        .builderVersion == "0.38.0" and .originalRailpackFailureCode == null and .fallbackEligibility == "not_applicable"
        and .fallbackReason == null and .fallbackTemplateId == null and .fallbackTemplateVersion == null and .fallbackTemplateDigest == null
      else
        .originalRailpackFailureCode == "DG_RAILPACK_INTERNAL_FAILURE" and .fallbackEligibility == "ELIGIBLE"
        and (.fallbackReason | type == "string" and length > 0) and (.fallbackTemplateId | type == "string" and length > 0)
        and (.fallbackTemplateVersion | type == "string" and length > 0) and (.fallbackTemplateDigest | test("^[0-9a-f]{64}$"))
      end)
    else true end)
    and (.servicePort == $release.terraform.services[.serviceId].service_port)
    and ($release.terraform.services[.serviceId].task_definition_arn | type == "string")
    and ($release.terraform.services[.serviceId].ecs_service_arn | type == "string")
    and ($release.terraform.services[.serviceId].alb_target_group_arn | type == "string")
    and ($release.terraform.services[.serviceId].public_url | test("^https?://"))
    and ($release.terraform.services[.serviceId].transport_probe_container_name == "deployguard-transport-probe")
    and (($release.terraform.services[.serviceId].transport_probe_port | type) == "number")
    and ($release.terraform.services[.serviceId].platform_health_check_path == "/_deployguard/transport-ready")
  )
  and all(.awsRuntimeVerification.services[];
    . as $outcome |
    ($release.terraform.services[$outcome.serviceId]) as $runtime |
    ($outcome.verified == true)
      and
      ($outcome.image == $runtime.image)
      and ($outcome.ecsServiceArn == $runtime.ecs_service_arn)
      and ($outcome.taskDefinitionArn == $runtime.task_definition_arn)
      and ($outcome.runningTaskArns | type == "array" and length > 0)
      and ($outcome.ecsTasksRunning == ($outcome.runningTaskArns | length))
      and ($outcome.runtimePort == $runtime.service_port)
      and ($outcome.readinessMode == "platform_transport")
      and ($outcome.applicationReachabilityPath == "alb_to_task_eni")
      and ($outcome.transportProbePort == $runtime.transport_probe_port)
      and ($outcome.platformHealthCheckPath == $runtime.platform_health_check_path)
      and ($outcome.targetGroupArn == $runtime.alb_target_group_arn)
      and ($outcome.targetHealth | type == "array" and length > 0 and all(. == "healthy"))
      and ($outcome.taskIpAddresses | type == "array" and length > 0)
      and ($outcome.targetRegistrations | type == "array" and length > 0)
      and (all($outcome.taskIpAddresses[]; . as $ip | any($outcome.targetRegistrations[]; .targetId == $ip and .port == $runtime.service_port and .state == "healthy")))
      and (all($outcome.targetRegistrations[]; (.targetId as $ip | $outcome.taskIpAddresses | index($ip)) != null or .state == "draining"))
      and ($outcome.alb | type == "object")
      and ($outcome.alb.state == "active")
      and ($outcome.alb.dnsName == ($runtime.public_url | ltrimstr("http://") | rtrimstr("/")))
      and ($outcome.alb.scheme == "internet-facing")
      and ($outcome.alb.type == "application")
      and ($outcome.listener | type == "object")
      and ($outcome.listener.port == 80)
      and ($outcome.listener.protocol == "HTTP")
      and ($outcome.listener.defaultTargetGroupArn == $runtime.alb_target_group_arn)
      and ($outcome.publicProbe | type == "object")
      and ($outcome.publicProbe.classification == "READY")
      and ($outcome.publicProbe.hostname == ($runtime.public_url | ltrimstr("http://") | rtrimstr("/")))
      and ($outcome.publicProbe.resolvedIpAddresses | type == "array" and length > 0)
      and ($outcome.publicProbe.dnsAttempts | type == "number" and . >= 1)
      and ($outcome.publicProbe.attemptCount | type == "number" and . >= 1)
      and ($outcome.publicProbe.curlExitCode == 0)
      and ($outcome.publicProbe.httpStatus | test("^[1-5][0-9]{2}$"))
      and ($outcome.publicProbe.httpStatus != "502" and $outcome.publicProbe.httpStatus != "503" and $outcome.publicProbe.httpStatus != "504")
      and ($outcome.publicProbe.remoteIp | test("^[0-9]{1,3}(\\.[0-9]{1,3}){3}$"))
      and ($outcome.environment | type == "object")
      and ($outcome.environment.PORT == ($runtime.service_port | tostring))
      and ($outcome.environment.HOST == "0.0.0.0")
      and ($outcome.secretValueFrom | type == "object")
      and ($outcome.managedDatabase | type == "object")
      and ($outcome.publicUrl == $runtime.public_url)
      and ($outcome.publicEndpointVerified == true)
      and ($outcome.taskDefinition == true)
      and ($outcome.secretsInjection == true)
      and ($outcome.vpcConnectivity == true)
      and ($outcome.publicReachability == true)
  )
' "${result}.next" >/dev/null || contract_failure

mv "${result}.next" "$result"
