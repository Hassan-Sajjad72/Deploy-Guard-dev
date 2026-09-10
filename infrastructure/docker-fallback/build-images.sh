#!/usr/bin/env bash
set -euo pipefail

fallback_root="$1"
railpack_version=0.38.0
railpack_sha256=7c3f0e70ca8bf80bde87e8c30cb0171414c2b6bbd794d6f60a19cc3b71772950
contract="$fallback_root/fallback-contract.mjs"
manifest="$fallback_root/templates.json"
mkdir -p .deployguard/fallback-attempts
jq -e --arg version "$railpack_version" --arg checksum "$railpack_sha256" '.version==$version and .archiveSha256==$checksum and .checksumVerified==true' .deployguard/railpack-install.json >/dev/null || { echo 'DG_FAILURE code=DG_RAILPACK_PREREQUISITE_FAILED stage=prepare_build message=unverified_railpack_identity' >&2; exit 1; }

safe_log() {
  node - "$1" "$2" <<'NODE'
const fs = require("fs");
let value = fs.readFileSync(process.argv[2], "utf8");
const secrets = JSON.parse(fs.readFileSync(process.argv[3], "utf8"));
for (const secret of Object.values(secrets)) if (typeof secret === "string" && secret.length >= 4) value = value.split(secret).join("[REDACTED]");
value = value.replace(/((?:password|passwd|token|secret|api[_-]?key|authorization)\s*[:=]\s*)\S+/gi, "$1[REDACTED]").replace(/[^\x09\x0a\x0d\x20-\x7e]/g, "");
process.stdout.write(value.slice(-12000));
NODE
}

terminal_failure() {
  local service="$1" code="$2" stage="$3" summary="$4" evidence_file="$5" eligibility="$6" reason="$7" fallback_json="${8:-null}"
  local service_id
  service_id="$(jq -r '.serviceId' <<<"$service")"
  jq -n --arg operationId "$OPERATION_ID" --arg projectId "$PROJECT_ID" --arg sourceSha "$SOURCE_SHA" --arg serviceId "$service_id" --arg code "$code" --arg stage "$stage" --arg summary "$summary" --arg safeEvidence "$(cat "$evidence_file")" --arg eligibility "$eligibility" --arg reason "$reason" --argjson service "$service" --argjson fallback "$fallback_json" '{contractVersion:"deployguard.failure-event/v1",operationId:$operationId,projectId:$projectId,sourceSha:$sourceSha,serviceId:$serviceId,code:$code,stage:$stage,summary:$summary,safeEvidence:($safeEvidence|.[0:12000]),buildIdentity:{buildTargetRevisionId:$service.buildTargetRevisionId,buildTargetFingerprint:$service.buildTarget.fingerprint,runtimeConfigRevisionId:$service.runtimeConfigRevisionId,runtimeConfigFingerprint:$service.runtimeConfigFingerprint,railpackBuildCapabilityFingerprint:($service.railpackBuildCapabilityFingerprint//null)},builder:{primary:"railpack",primaryVersion:"0.38.0",originalRailpackFailureCode:(if $code=="DG_RAILPACK_BUILD_FAILED" then $code else "DG_RAILPACK_INTERNAL_FAILURE" end),fallbackEligibility:$eligibility,fallbackReason:$reason,fallback:$fallback}}' > .deployguard/terminal-failure.json
  echo "DG_FAILURE serviceId=$service_id code=$code stage=$stage" >&2
  rm -f "${build_environment_file:-}" "${build_secrets_file:-}" "${railpack_log:-}" "${safe_evidence:-}" "${selection_file:-}"
  exit 1
}

account="$(aws sts get-caller-identity --query Account --output text)"
registry="${account}.dkr.ecr.${AWS_REGION}.amazonaws.com"
docker version --format '{{.Server.Version}}' >/dev/null || { echo 'DG_FAILURE code=DG_RAILPACK_PREREQUISITE_FAILED stage=prepare_build' >&2; exit 1; }
docker run --rm --privileged --detach --name "$BUILDKIT_CONTAINER" "$BUILDKIT_IMAGE" >/dev/null || { echo 'DG_FAILURE code=DG_RAILPACK_PREREQUISITE_FAILED stage=prepare_build' >&2; exit 1; }
for attempt in {1..30}; do docker exec "$BUILDKIT_CONTAINER" buildctl debug workers >/dev/null 2>&1 && break; [ "$attempt" -lt 30 ] || { echo 'DG_FAILURE code=DG_RAILPACK_PREREQUISITE_FAILED stage=prepare_build' >&2; exit 1; }; sleep 1; done
printf '[]' > .deployguard/build-artifacts.json

while IFS= read -r service; do
  service_id="$(jq -r '.serviceId' <<<"$service")"; service_name="$(jq -r '.serviceName' <<<"$service")"; directory="$(jq -r '.serviceDirectory' <<<"$service")"; build_root="$(jq -r '.buildTarget.buildRoot' <<<"$service")"; package_target="$(jq -r '.buildTarget.execution.packageTarget // empty' <<<"$service")"; build_command="$(jq -r '.buildTarget.execution.buildCommand // empty' <<<"$service")"; start_command="$(jq -r '.buildTarget.execution.startCommand // empty' <<<"$service")"
  compact_project="${PROJECT_ID//-/}"; compact_operation="${OPERATION_ID//-/}"; compact_service="${service_id//-/}"
  repository="deployguard-${compact_project:0:12}-${compact_service:0:8}"; tag="sha-${SOURCE_SHA:0:10}-${compact_operation:0:8}-${compact_service:0:8}"; image="${registry}/${repository}:${tag}"
  echo "DG_SERVICE_STAGE serviceId=$service_id stage=railpack_build buildRoot=$build_root serviceDirectory=$directory packageTarget=$package_target"
  sealed_capabilities="$(jq -S -c '.buildEnvironment | with_entries(. as $entry | select(["RAILPACK_BUILD_APT_PACKAGES","RAILPACK_DEPLOY_APT_PACKAGES","RAILPACK_PACKAGES","RAILPACK_PYTHON_VERSION","RAILPACK_NODE_VERSION"] | index($entry.key)))' <<<"$service")"
  sealed_capability_fingerprint="$(jq -r '.railpackBuildCapabilityFingerprint // empty' <<<"$service")"
  if [ -n "$sealed_capability_fingerprint" ]; then
    calculated_capability_fingerprint="$(printf '%s' "$sealed_capabilities" | sha256sum | cut -d' ' -f1)"
    [ "$calculated_capability_fingerprint" = "$sealed_capability_fingerprint" ] || { echo "DG_FAILURE serviceId=$service_id code=DG_RAILPACK_CAPABILITY_FORWARDING_FAILED stage=railpack_build message=sealed_capability_fingerprint_mismatch" >&2; exit 1; }
  fi
  build_env_args=(); build_env_names=(); build_environment_file="$(mktemp)"; build_secrets_file="$(mktemp)"; railpack_log="$(mktemp)"; safe_evidence="$(mktemp)"; selection_file="$(mktemp)"; chmod 600 "$build_environment_file" "$build_secrets_file" "$railpack_log" "$safe_evidence" "$selection_file"
  jq -c '.buildEnvironment' <<<"$service" > "$build_environment_file"; printf '{}' > "$build_secrets_file"
  while IFS= read -r entry; do
    key="$(base64 --decode <<<"$entry" | jq -r '.key')"; value="$(base64 --decode <<<"$entry" | jq -r '.value')"
    printf -v "$key" '%s' "$value"; export "${key?}"; build_env_names+=("$key"); build_env_args+=(--env "$key")
  done < <(jq -r '.buildEnvironment | to_entries[] | @base64' <<<"$service")
  while IFS= read -r entry; do
    key="$(base64 --decode <<<"$entry" | jq -r '.key')"; reference="$(base64 --decode <<<"$entry" | jq -r '.value')"; secret_id="$(cut -d: -f1-7 <<<"$reference")"; version_id="${reference##*:}"
    value="$(aws secretsmanager get-secret-value --secret-id "$secret_id" --version-id "$version_id" --query SecretString --output text | jq -er --arg key "$key" '.[$key] | select(type == "string")')"
    printf -v "$key" '%s' "$value"; export "${key?}"; build_env_names+=("$key"); build_env_args+=(--env "$key")
    jq --arg key "$key" --arg value "$value" '. + {($key):$value}' "$build_secrets_file" > "${build_secrets_file}.next"; mv "${build_secrets_file}.next" "$build_secrets_file"
  done < <(jq -r '.buildSecretReferences | to_entries[] | @base64' <<<"$service")
  while IFS= read -r entry; do
    key="$(base64 --decode <<<"$entry" | jq -r '.key')"; value="$(base64 --decode <<<"$entry" | jq -r '.value')"
    [ "${!key+x}" = x ] && [ "${!key}" = "$value" ] || { echo "DG_FAILURE serviceId=$service_id code=DG_RAILPACK_CAPABILITY_FORWARDING_FAILED stage=railpack_build message=sealed_capability_not_forwarded" >&2; exit 1; }
  done < <(jq -r '.buildEnvironment | to_entries[] | . as $entry | select(["RAILPACK_BUILD_APT_PACKAGES","RAILPACK_DEPLOY_APT_PACKAGES","RAILPACK_PACKAGES","RAILPACK_PYTHON_VERSION","RAILPACK_NODE_VERSION"] | index($entry.key)) | @base64' <<<"$service")
  execution_args=(); if [ -n "$build_command" ]; then execution_args+=(--build-cmd "$build_command"); [ -z "$start_command" ] || execution_args+=(--start-cmd "$start_command"); elif [ -n "$start_command" ]; then echo "DG_FAILURE serviceId=$service_id code=DG_WORKFLOW_CONTRACT_INVALID stage=build_target_execution" >&2; exit 1; fi

  set +e
  BUILDKIT_HOST="docker-container://${BUILDKIT_CONTAINER}" railpack build "${build_env_args[@]}" "${execution_args[@]}" --name "$image" "$build_root" >"$railpack_log" 2>&1
  railpack_exit=$?
  set -e
  safe_log "$railpack_log" "$build_secrets_file" > "$safe_evidence"
  [ ! -s "$safe_evidence" ] || cat "$safe_evidence" >&2
  builder=railpack; builder_version="$railpack_version"; original_failure=null; eligibility=not_applicable; fallback_reason=null; template_id=null; template_version=null; template_digest=null
  if [ "$railpack_exit" -ne 0 ]; then
    if classification="$(node "$contract" classify --exit-code "$railpack_exit" --evidence "$railpack_log" --complete true --railpack-version "$railpack_version" --railpack-sha256 "$railpack_sha256")"; then
      eligibility="$(jq -r '.decision' <<<"$classification")"; fallback_reason="$(jq -r '.reason' <<<"$classification")"; original_failure=DG_RAILPACK_INTERNAL_FAILURE
      printf '%s' "$service" > "$selection_file"
      if selection="$(node "$contract" select --service "$selection_file" --manifest "$manifest" --root "$fallback_root" --ledger ".deployguard/fallback-attempts/${OPERATION_ID}-${service_id}")"; then
        template_id="$(jq -r '.templateId' <<<"$selection")"; template_version="$(jq -r '.templateVersion' <<<"$selection")"; template_digest="$(jq -r '.templateDigest' <<<"$selection")"; template_path="$(jq -r '.templatePath' <<<"$selection")"; fallback_reason="$(jq -r '.reason' <<<"$selection")"
        echo "DG_BUILDER_EVENT serviceId=$service_id builder=deployguard_docker_fallback status=selected reason=$fallback_reason templateId=$template_id templateVersion=$template_version templateDigest=$template_digest"
        set +e
        DOCKER_BUILDKIT=1 docker build --file "$template_path" --build-arg "DG_PACKAGE_TARGET=$package_target" --secret "id=deployguard_build_environment,src=$build_environment_file" --secret "id=deployguard_build_secrets,src=$build_secrets_file" --tag "$image" "$build_root" >"$railpack_log" 2>&1
        fallback_exit=$?
        set -e
        safe_log "$railpack_log" "$build_secrets_file" > "$safe_evidence"; [ ! -s "$safe_evidence" ] || cat "$safe_evidence" >&2
        [ "$fallback_exit" -eq 0 ] || terminal_failure "$service" DG_DOCKER_FALLBACK_BUILD_FAILED docker_fallback_build "The certified Docker fallback build failed." "$safe_evidence" ELIGIBLE "$fallback_reason" "$selection"
        builder=deployguard_docker_fallback; builder_version="$template_version"
        echo "DG_BUILDER_EVENT serviceId=$service_id builder=deployguard_docker_fallback status=succeeded originalFailure=DG_RAILPACK_INTERNAL_FAILURE"
      else
        code="$(jq -r '.code // "DG_DOCKER_FALLBACK_CONTRACT_INVALID"' <<<"$selection")"; reason="$(jq -r '.reason // "fallback_selection_failed"' <<<"$selection")"
        terminal_failure "$service" "$code" docker_fallback_selection "Railpack encountered an internal builder failure, but this application's build contract is outside DeployGuard's certified Docker fallback compatibility." "$safe_evidence" ELIGIBLE "$reason" "$selection"
      fi
    else
      terminal_failure "$service" DG_RAILPACK_BUILD_FAILED railpack_build "The Railpack application build failed." "$safe_evidence" NOT_ELIGIBLE railpack_failure_not_proven_internal
    fi
  fi
  for key in "${build_env_names[@]}"; do unset "$key"; done
  runtime_config_revision_id="$(jq -r '.runtimeConfigRevisionId' <<<"$service")"; runtime_config_fingerprint="$(jq -r '.runtimeConfigFingerprint' <<<"$service")"; build_target_revision_id="$(jq -r '.buildTargetRevisionId' <<<"$service")"; build_target_fingerprint="$(jq -r '.buildTarget.fingerprint' <<<"$service")"; service_port="$(jq -r '.servicePort' <<<"$service")"
  image_id="$(docker image inspect --format '{{.Id}}' "$image" 2>/dev/null || true)"
  if [[ ! "$image_id" =~ ^sha256:[0-9a-f]{64}$ ]]; then
    if [ "$builder" = railpack ]; then
      terminal_failure "$service" DG_RAILPACK_BUILD_FAILED railpack_build "Railpack did not produce an immutable local image." "$safe_evidence" NOT_ELIGIBLE railpack_image_missing
    fi
    terminal_failure "$service" DG_DOCKER_FALLBACK_BUILD_FAILED docker_fallback_build "The certified Docker fallback did not produce an immutable local image." "$safe_evidence" "$eligibility" "$fallback_reason"
  fi
  jq --arg id "$service_id" --arg name "$service_name" --arg directory "$directory" --arg buildRoot "$build_root" --argjson servicePort "$service_port" --arg runtimeConfigRevisionId "$runtime_config_revision_id" --arg runtimeConfigFingerprint "$runtime_config_fingerprint" --arg buildTargetRevisionId "$build_target_revision_id" --arg buildTargetFingerprint "$build_target_fingerprint" --arg image "$image" --arg imageId "$image_id" --arg repository "$repository" --arg registry "$registry" --arg builder "$builder" --arg builderVersion "$builder_version" --arg sourceSha "$SOURCE_SHA" --arg operationId "$OPERATION_ID" --arg originalFailure "$original_failure" --arg eligibility "$eligibility" --arg fallbackReason "$fallback_reason" --arg templateId "$template_id" --arg templateVersion "$template_version" --arg templateDigest "$template_digest" '. + [{serviceId:$id,serviceName:$name,serviceDirectory:$directory,buildRoot:$buildRoot,servicePort:$servicePort,runtimeConfigRevisionId:$runtimeConfigRevisionId,runtimeConfigFingerprint:$runtimeConfigFingerprint,buildTargetRevisionId:$buildTargetRevisionId,buildTargetFingerprint:$buildTargetFingerprint,localImage:$image,localImageId:$imageId,repository:$repository,registry:$registry,builder:$builder,builderVersion:$builderVersion,sourceSha:$sourceSha,operationId:$operationId,originalRailpackFailureCode:(if $originalFailure=="null" then null else $originalFailure end),fallbackEligibility:$eligibility,fallbackReason:(if $fallbackReason=="null" then null else $fallbackReason end),fallbackTemplateId:(if $templateId=="null" then null else $templateId end),fallbackTemplateVersion:(if $templateVersion=="null" then null else $templateVersion end),fallbackTemplateDigest:(if $templateDigest=="null" then null else $templateDigest end)}]' .deployguard/build-artifacts.json > .deployguard/build-artifacts.next
  mv .deployguard/build-artifacts.next .deployguard/build-artifacts.json
  rm -f "$build_environment_file" "$build_secrets_file" "$railpack_log" "$safe_evidence" "$selection_file"
done < <(jq -c '.services[]' .deployguard/runtime.json)

echo 'built=true' >> "$GITHUB_OUTPUT"
