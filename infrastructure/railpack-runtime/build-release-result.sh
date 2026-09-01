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
  and (.awsRuntimeVerification.verified | type == "boolean")
  and (.awsRuntimeVerification.verifiedAt | type == "string")
  and (.awsRuntimeVerification.services | type == "array")
  and ($outcome_service_ids | length == (unique | length))
  and ($outcome_service_ids == $service_ids)
  and (.awsRuntimeVerification.verified == ([.awsRuntimeVerification.services[].verified] | all(. == true)))
  and all(.services[];
    (.serviceId | type == "string")
    and ((.servicePort | type) == "number" and (.servicePort | floor) == .servicePort and .servicePort >= 1 and .servicePort <= 65535)
    and (.runtimeConfigRevisionId | type == "string")
    and (.imageUri | type == "string")
    and (.imageDigest | test("^sha256:[0-9a-f]{64}$"))
    and (.image == (.imageUri + "@" + .imageDigest))
    and (.image == $release.terraform.services[.serviceId].image)
    and (.runtimeConfigRevisionId == $release.terraform.services[.serviceId].runtime_config_revision_id)
    and (.servicePort == $release.terraform.services[.serviceId].service_port)
    and ($release.terraform.services[.serviceId].task_definition_arn | type == "string")
    and ($release.terraform.services[.serviceId].ecs_service_arn | type == "string")
    and ($release.terraform.services[.serviceId].alb_target_group_arn | type == "string")
    and ($release.terraform.services[.serviceId].public_url | test("^https?://"))
  )
  and all(.awsRuntimeVerification.services[];
    . as $outcome |
    ($release.terraform.services[$outcome.serviceId]) as $runtime |
    if $outcome.verified == true then
      ($outcome.image == $runtime.image)
      and ($outcome.ecsServiceArn == $runtime.ecs_service_arn)
      and ($outcome.taskDefinitionArn == $runtime.task_definition_arn)
      and ($outcome.runningTaskArns | type == "array" and length > 0)
      and ($outcome.ecsTasksRunning == ($outcome.runningTaskArns | length))
      and ($outcome.runtimePort == $runtime.service_port)
      and ($outcome.targetGroupArn == $runtime.alb_target_group_arn)
      and ($outcome.targetHealth | type == "array" and length > 0 and all(. == "healthy"))
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
    else
      ($outcome.verified == false)
      and ($outcome.failureCode | type == "string" and length > 0)
    end
  )
' "${result}.next" >/dev/null || contract_failure

mv "${result}.next" "$result"
