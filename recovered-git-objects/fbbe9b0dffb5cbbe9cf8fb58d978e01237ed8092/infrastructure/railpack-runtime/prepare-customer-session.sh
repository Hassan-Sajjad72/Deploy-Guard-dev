#!/usr/bin/env bash
# Reads protected control-plane authorization before customer role chaining.
set -euo pipefail
fail() { echo 'DG_FAILURE code=DG_CUSTOMER_AUTHORIZATION_INVALID stage=customer_authorization' >&2; exit 1; }
[[ "${CUSTOMER_ACCOUNT_ID:-}" =~ ^[0-9]{12}$ && "${APPROVED_PLAN_ID:-}" =~ ^[0-9a-f-]{36}$ && "${APPROVED_PLAN_FINGERPRINT:-}" =~ ^[0-9a-f]{64}$ ]] || fail
[[ "${CUSTOMER_BINDING_SECRET_ARN:-}" =~ ^arn:aws:secretsmanager:[a-z0-9-]+:[0-9]{12}:secret:deployguard/customer-bindings/[0-9a-f-]{36}/[0-9a-f-]{36}-[A-Za-z0-9]{6}$ ]] || fail
umask 077
mkdir -p .deployguard
printf '%s' "$WORKLOAD_BASE64" | base64 --decode > .deployguard/customer-workload.json || fail
jq -e --arg project "$PROJECT_ID" --arg operation "$OPERATION_ID" --arg source "$SOURCE_SHA" --arg environment "$ENVIRONMENT_NAME" --arg account "$CUSTOMER_ACCOUNT_ID" '
  .contractVersion == "deployguard.customer-workload/v1" and .projectId == $project and .operationId == $operation and .sourceSha == $source and .environment == $environment
  and (.organizationId | test("^[0-9a-f-]{36}$")) and (.bindingId | test("^[0-9a-f-]{36}$")) and (.bindingVersion | type == "number" and . >= 1 and floor == .)
  and (.roleArn | startswith("arn:aws:iam::" + $account + ":role/"))
  and (.cpu | type == "number") and (.memoryMiB | type == "number" and floor == .) and (.replicas | type == "number" and . >= 1 and . <= 100 and floor == .)
  and (if .cpu == 0.25 then (.memoryMiB == 512 or .memoryMiB == 1024 or .memoryMiB == 2048) elif .cpu == 0.5 then (.memoryMiB >= 1024 and .memoryMiB <= 4096 and .memoryMiB % 1024 == 0) elif .cpu == 1 then (.memoryMiB >= 2048 and .memoryMiB <= 8192 and .memoryMiB % 1024 == 0) elif .cpu == 2 then (.memoryMiB >= 4096 and .memoryMiB <= 16384 and .memoryMiB % 1024 == 0) elif .cpu == 4 then (.memoryMiB >= 8192 and .memoryMiB <= 30720 and .memoryMiB % 1024 == 0) elif .cpu == 8 then (.memoryMiB >= 16384 and .memoryMiB <= 61440 and .memoryMiB % 4096 == 0) elif .cpu == 16 then (.memoryMiB >= 32768 and .memoryMiB <= 122880 and .memoryMiB % 8192 == 0) else false end)' .deployguard/customer-workload.json >/dev/null || fail
secret="$(aws secretsmanager get-secret-value --secret-id "$CUSTOMER_BINDING_SECRET_ARN" --query SecretString --output text)" || fail
external_id="$(jq -r '.externalId // empty' <<<"$secret")"
[[ "$external_id" =~ ^[A-Za-z0-9+=,.@:/_-]{16,1224}$ ]] || fail
printf '::add-mask::%s\n' "$external_id"
jq -e --arg account "$CUSTOMER_ACCOUNT_ID" --slurpfile workload .deployguard/customer-workload.json '
 .contractVersion == "deployguard.customer-binding/v1" and .accountId == $account and .roleArn == $workload[0].roleArn and .organizationId == $workload[0].organizationId and .bindingId == $workload[0].bindingId and .bindingVersion == $workload[0].bindingVersion' <<<"$secret" >/dev/null || fail
expected_path="deployguard/customer-bindings/$(jq -r '.organizationId' <<<"$secret")/$(jq -r '.bindingId' <<<"$secret")-"
[[ "$CUSTOMER_BINDING_SECRET_ARN" == *":secret:$expected_path"* ]] || fail
printf 'role_arn=%s\nexternal_id=%s\n' "$(jq -r '.roleArn' <<<"$secret")" "$external_id" >> "$GITHUB_OUTPUT"
unset secret external_id
