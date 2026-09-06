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

sleep_within_deadline() {
  local started="$1" max_elapsed="$2" requested="$3" elapsed remaining duration
  elapsed=$((SECONDS - started)); remaining=$((max_elapsed - elapsed))
  [ "$remaining" -gt 0 ] || return 1
  duration="$requested"; [ "$duration" -le "$remaining" ] || duration="$remaining"
  [ "$duration" -eq 0 ] || sleep "$duration"
}

configuration_failure() {
  local service_id="$1" message="$2"
  echo "DG_FAILURE serviceId=$service_id code=DG_AWS_RUNTIME_CONFIGURATION_FAILED stage=aws_runtime_verification" >&2
  append_outcome "$service_id" false DG_AWS_RUNTIME_CONFIGURATION_FAILED "$message" aws_runtime_verification
  local diagnostic
  diagnostic="$(jq -cn --arg diagnosticCode AWS_RUNTIME_CONFIGURATION_MISMATCH --arg summary "$message" '{diagnosticCode:$diagnosticCode,classification:"FATAL",summary:$summary}')"
  attach_diagnostics "$service_id" "$diagnostic" || true
  printf '%s\n' "$diagnostic" | sed 's/^/DG_ECS_DIAGNOSTICS /' >&2 || true
  exit 1
}

provider_failure() {
  local service_id="$1" detail="$2" safe_detail diagnostic code summary
  safe_detail="$(printf '%s\n' "$detail" | sanitize)"
  if grep -Eqi 'AccessDenied|not authorized|UnauthorizedOperation' <<<"$detail"; then
    printf '%s\n' "$safe_detail" >&2
    echo "DG_FAILURE serviceId=$service_id code=DG_AWS_AUTHORIZATION_FAILED stage=aws_runtime_verification" >&2
    code=DG_AWS_AUTHORIZATION_FAILED; summary="AWS authorization failed during terminal reconciliation."
  else
    printf '%s\n' "$safe_detail" >&2
    echo "DG_FAILURE serviceId=$service_id code=DG_AWS_PROVIDER_FAILED stage=aws_runtime_verification" >&2
    code=DG_AWS_PROVIDER_FAILED; summary="AWS provider observation failed during terminal reconciliation."
  fi
  append_outcome "$service_id" false "$code" "$summary" aws_runtime_verification
  diagnostic="$(jq -cn --arg detail "$safe_detail" '{diagnosticCode:"AWS_PROVIDER_OBSERVATION_FAILED",classification:"FATAL",providerDetail:$detail}')"
  attach_diagnostics "$service_id" "$diagnostic" || true
  exit 1
}

ecs_diagnostics() {
  local service_id="$1" cluster="$2" service_name="$3" target_group="$4" log_group="$5"
  local stopped_arns tasks service_description target_health logs start_ms diagnostic
  local -a stopped_task_arns
  echo "DG_FAILURE serviceId=$service_id code=DG_ECS_STABILITY_FAILED stage=ecs_stability" >&2
  append_outcome "$service_id" false DG_ECS_STABILITY_FAILED "ECS service stability or runtime-process verification failed." ecs_stability
  stopped_arns="$(aws ecs list-tasks --cluster "$cluster" --service-name "$service_name" --desired-status STOPPED --max-results 20 --output json 2>/dev/null || printf '{"taskArns":[]}')"
  tasks='{"tasks":[]}'
  if [ "$(jq '.taskArns | length' <<<"$stopped_arns")" -gt 0 ]; then
    mapfile -t stopped_task_arns < <(jq -r '.taskArns[]' <<<"$stopped_arns")
    tasks="$(aws ecs describe-tasks --cluster "$cluster" --tasks "${stopped_task_arns[@]}" --output json 2>/dev/null || printf '{"tasks":[]}')"
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
      {diagnosticCode:"ECS_STABILITY_FAILED",classification:(if ($task.stopCode != null or $container.exitCode != null) then "FATAL" else "TRANSIENT_TIMEOUT" end),stopCode:($task.stopCode//null),stoppedTaskReason:($task.stoppedReason//null),containerExitCode:($container.exitCode//null),containerReason:($container.reason//null),taskEvents:((($service.services // [])[0].events // [])[0:12] | map(.message // null)),targetHealth:(($target.TargetHealthDescriptions // [])[0:20] | map({targetId:(.Target.Id//null),port:(.Target.Port//null),state:(.TargetHealth.State//null),reason:(.TargetHealth.Reason//null),description:(.TargetHealth.Description//null)})),logLines:(($logs.events // [])[-25:] | map(.message // null))}' 2>/dev/null || printf '{"diagnosticCode":"ECS_STABILITY_FAILED","classification":"TRANSIENT_TIMEOUT","diagnosticsUnavailable":true}')"
  diagnostic="$(printf '%s\n' "$diagnostic" | sanitize)"
  jq -e 'type == "object"' <<<"$diagnostic" >/dev/null 2>&1 || diagnostic='{"diagnosticCode":"ECS_STABILITY_FAILED","diagnosticsUnavailable":true}'
  attach_diagnostics "$service_id" "$diagnostic" || true
  printf '%s\n' "$diagnostic" | sed 's/^/DG_ECS_DIAGNOSTICS /' >&2 || true
  exit 1
}

wait_for_target_health() {
  local service_id="$1" target_group="$2" expected_targets="$3" expected_port="$4" attempt detail started elapsed remaining observation_status
  local max_attempts="${DEPLOYGUARD_TARGET_HEALTH_MAX_ATTEMPTS:-20}"
  local interval_seconds="${DEPLOYGUARD_TARGET_HEALTH_INTERVAL_SECONDS:-6}"
  local max_elapsed_seconds="${DEPLOYGUARD_TARGET_HEALTH_MAX_ELAPSED_SECONDS:-180}"
  [[ "$max_attempts" =~ ^[1-9][0-9]*$ ]] && [ "$max_attempts" -le 120 ] || configuration_failure "$service_id" "Target-health attempt limit is invalid."
  [[ "$interval_seconds" =~ ^[0-9]+$ ]] && [ "$interval_seconds" -le 30 ] || configuration_failure "$service_id" "Target-health interval is invalid."
  [[ "$max_elapsed_seconds" =~ ^[1-9][0-9]*$ ]] && [ "$max_elapsed_seconds" -le 900 ] || configuration_failure "$service_id" "Target-health elapsed-time limit is invalid."
  started="$SECONDS"
  target_health='{"TargetHealthDescriptions":[]}'
  for ((attempt=1; attempt<=max_attempts; attempt++)); do
    elapsed=$((SECONDS - started)); remaining=$((max_elapsed_seconds - elapsed)); [ "$remaining" -gt 0 ] || break
    if detail="$(timeout "$remaining" aws elbv2 describe-target-health --target-group-arn "$target_group" --output json 2>&1)"; then observation_status=0; else observation_status=$?; fi
    [ "$observation_status" -ne 124 ] || break
    [ "$observation_status" -eq 0 ] || provider_failure "$service_id" "$detail"
    target_health="$detail"
    if jq -e --argjson expected "$expected_targets" --argjson port "$expected_port" '
      ($expected | sort | unique) as $current |
      [.TargetHealthDescriptions[]? | {id:.Target.Id,port:.Target.Port,state:.TargetHealth.State}] as $observed |
      ($current | length > 0)
      and all($current[]; . as $id | any($observed[]; .id == $id and .port == $port and .state == "healthy"))
      and all($observed[]; (.id as $id | ($current | index($id)) != null) or .state == "draining")
    ' <<<"$target_health" >/dev/null; then
      return 0
    fi
    if jq -e --argjson expected "$expected_targets" --argjson port "$expected_port" '
      any(.TargetHealthDescriptions[]?;
        (((.Target.Id as $id | ($expected | index($id)) == null)
          or ((.Target.Id as $id | ($expected | index($id)) != null) and .Target.Port != $port))
        and .TargetHealth.State != "draining"))
    ' <<<"$target_health" >/dev/null; then
      return 2
    fi
    elapsed=$((SECONDS - started))
    [ "$attempt" -eq "$max_attempts" ] || sleep_within_deadline "$started" "$max_elapsed_seconds" "$interval_seconds" || break
    [ "$elapsed" -lt "$max_elapsed_seconds" ] || break
  done
  return 1
}

runtime_failure() {
  local service_id="$1" code="$2" stage="$3" summary="$4" diagnostic="${5:-}"
  echo "DG_FAILURE serviceId=$service_id code=$code stage=$stage" >&2
  append_outcome "$service_id" false "$code" "$summary" "$stage"
  if [ -n "$diagnostic" ]; then
    diagnostic="$(printf '%s\n' "$diagnostic" | sanitize)"
    jq -e 'type == "object"' <<<"$diagnostic" >/dev/null 2>&1 || diagnostic='{"diagnosticCode":"RUNTIME_CONVERGENCE_EVIDENCE_UNAVAILABLE"}'
    attach_diagnostics "$service_id" "$diagnostic" || true
    printf '%s\n' "$diagnostic" | sed 's/^/DG_RUNTIME_DIAGNOSTICS /' >&2 || true
  fi
  exit 1
}

wait_for_alb_active() {
  local service_id="$1" alb_arn="$2" expected_security_group="$3" attempt detail state started elapsed diagnostic remaining observation_status
  local max_attempts="${DEPLOYGUARD_ALB_MAX_ATTEMPTS:-30}"
  local interval_seconds="${DEPLOYGUARD_ALB_INTERVAL_SECONDS:-5}"
  local max_elapsed_seconds="${DEPLOYGUARD_ALB_MAX_ELAPSED_SECONDS:-180}"
  [[ "$max_attempts" =~ ^[1-9][0-9]*$ ]] && [ "$max_attempts" -le 120 ] || configuration_failure "$service_id" "ALB attempt limit is invalid."
  [[ "$interval_seconds" =~ ^[0-9]+$ ]] && [ "$interval_seconds" -le 30 ] || configuration_failure "$service_id" "ALB interval is invalid."
  [[ "$max_elapsed_seconds" =~ ^[1-9][0-9]*$ ]] && [ "$max_elapsed_seconds" -le 900 ] || configuration_failure "$service_id" "ALB elapsed-time limit is invalid."
  started="$SECONDS"
  alb_observation='{"state":"unknown","dnsName":null,"scheme":null,"type":null,"securityGroups":[]}'
  for ((attempt=1; attempt<=max_attempts; attempt++)); do
    elapsed=$((SECONDS - started)); remaining=$((max_elapsed_seconds - elapsed)); [ "$remaining" -gt 0 ] || break
    if detail="$(timeout "$remaining" aws elbv2 describe-load-balancers --load-balancer-arns "$alb_arn" --output json 2>&1)"; then observation_status=0; else observation_status=$?; fi
    [ "$observation_status" -ne 124 ] || break
    [ "$observation_status" -eq 0 ] || provider_failure "$service_id" "$detail"
    alb_observation="$(jq -c --arg arn "$alb_arn" '(.LoadBalancers | map(select(.LoadBalancerArn == $arn)) | first // {}) | {state:(.State.Code // "unknown"),dnsName:(.DNSName // null),scheme:(.Scheme // null),type:(.Type // null),ipAddressType:(.IpAddressType // null),securityGroups:(.SecurityGroups // [])}' <<<"$detail")" || configuration_failure "$service_id" "ALB state evidence is invalid."
    state="$(jq -r '.state' <<<"$alb_observation")"
    if [ "$state" = active ]; then
      jq -e --arg sg "$expected_security_group" '.dnsName != null and .scheme == "internet-facing" and .type == "application" and (.securityGroups | index($sg) != null)' <<<"$alb_observation" >/dev/null || configuration_failure "$service_id" "The active ALB identity, scheme, type, DNS name, or security group does not match the immutable runtime."
      return 0
    fi
    if [ "$state" = failed ]; then
      diagnostic="$(jq -cn --argjson alb "$alb_observation" --argjson attempts "$attempt" --argjson elapsed "$((SECONDS - started))" '{diagnosticCode:"ALB_FAILED",classification:"FATAL",attempts:$attempts,elapsedSeconds:$elapsed,alb:$alb}')"
      runtime_failure "$service_id" DG_ALB_NOT_ACTIVE alb_readiness "The service ALB entered a failed state." "$diagnostic"
    fi
    elapsed=$((SECONDS - started))
    [ "$attempt" -eq "$max_attempts" ] || sleep_within_deadline "$started" "$max_elapsed_seconds" "$interval_seconds" || break
    [ "$elapsed" -lt "$max_elapsed_seconds" ] || break
  done
  diagnostic="$(jq -cn --argjson alb "$alb_observation" --argjson attempts "$((attempt > max_attempts ? max_attempts : attempt))" --argjson elapsed "$((SECONDS - started))" '{diagnosticCode:"ALB_READINESS_TIMEOUT",classification:"TRANSIENT_TIMEOUT",attempts:$attempts,elapsedSeconds:$elapsed,alb:$alb}')"
  runtime_failure "$service_id" DG_ALB_NOT_ACTIVE alb_readiness "The service ALB did not become active within the bounded convergence policy." "$diagnostic"
}

wait_for_listener() {
  local service_id="$1" alb_arn="$2" target_group="$3" attempt detail matching_count started elapsed diagnostic remaining observation_status
  local max_attempts="${DEPLOYGUARD_LISTENER_MAX_ATTEMPTS:-20}"
  local interval_seconds="${DEPLOYGUARD_LISTENER_INTERVAL_SECONDS:-3}"
  local max_elapsed_seconds="${DEPLOYGUARD_LISTENER_MAX_ELAPSED_SECONDS:-90}"
  [[ "$max_attempts" =~ ^[1-9][0-9]*$ ]] && [ "$max_attempts" -le 120 ] || configuration_failure "$service_id" "Listener attempt limit is invalid."
  [[ "$interval_seconds" =~ ^[0-9]+$ ]] && [ "$interval_seconds" -le 30 ] || configuration_failure "$service_id" "Listener interval is invalid."
  [[ "$max_elapsed_seconds" =~ ^[1-9][0-9]*$ ]] && [ "$max_elapsed_seconds" -le 900 ] || configuration_failure "$service_id" "Listener elapsed-time limit is invalid."
  started="$SECONDS"
  listener_observation='{"listenerArn":null,"port":null,"protocol":null,"defaultTargetGroupArn":null}'
  for ((attempt=1; attempt<=max_attempts; attempt++)); do
    elapsed=$((SECONDS - started)); remaining=$((max_elapsed_seconds - elapsed)); [ "$remaining" -gt 0 ] || break
    if detail="$(timeout "$remaining" aws elbv2 describe-listeners --load-balancer-arn "$alb_arn" --output json 2>&1)"; then observation_status=0; else observation_status=$?; fi
    [ "$observation_status" -ne 124 ] || break
    [ "$observation_status" -eq 0 ] || provider_failure "$service_id" "$detail"
    matching_count="$(jq '[.Listeners[]? | select(.Port == 80 and .Protocol == "HTTP")] | length' <<<"$detail")" || configuration_failure "$service_id" "ALB listener evidence is invalid."
    if [ "$matching_count" -gt 0 ]; then
      [ "$matching_count" -eq 1 ] || runtime_failure "$service_id" DG_ALB_LISTENER_MISMATCH alb_listener "The service ALB has ambiguous HTTP listeners." "$(jq -cn --argjson listeners "$detail" '{diagnosticCode:"ALB_LISTENER_AMBIGUOUS",classification:"FATAL",listeners:[$listeners.Listeners[]? | {listenerArn:.ListenerArn,port:.Port,protocol:.Protocol}]}')"
      listener_observation="$(jq -c '[.Listeners[] | select(.Port == 80 and .Protocol == "HTTP")] | first | {listenerArn:.ListenerArn,port:.Port,protocol:.Protocol,defaultTargetGroupArn:([.DefaultActions[]? | select(.Type == "forward") | .TargetGroupArn] | first // null)}' <<<"$detail")"
      jq -e --arg target "$target_group" '.defaultTargetGroupArn == $target' <<<"$listener_observation" >/dev/null || runtime_failure "$service_id" DG_ALB_LISTENER_MISMATCH alb_listener "The service ALB listener does not forward to the immutable target group." "$(jq -cn --argjson listener "$listener_observation" --arg expectedTargetGroupArn "$target_group" '{diagnosticCode:"ALB_LISTENER_MISMATCH",classification:"FATAL",expectedTargetGroupArn:$expectedTargetGroupArn,listener:$listener}')"
      return 0
    fi
    if jq -e 'any(.Listeners[]?; .Port == 80 or .Protocol == "HTTP")' <<<"$detail" >/dev/null; then
      runtime_failure "$service_id" DG_ALB_LISTENER_MISMATCH alb_listener "The service ALB listener has the wrong port or protocol." "$(jq -cn --argjson listeners "$detail" '{diagnosticCode:"ALB_LISTENER_MISMATCH",classification:"FATAL",listeners:[$listeners.Listeners[]? | {listenerArn:.ListenerArn,port:.Port,protocol:.Protocol}]}')"
    fi
    elapsed=$((SECONDS - started))
    [ "$attempt" -eq "$max_attempts" ] || sleep_within_deadline "$started" "$max_elapsed_seconds" "$interval_seconds" || break
    [ "$elapsed" -lt "$max_elapsed_seconds" ] || break
  done
  diagnostic="$(jq -cn --argjson attempts "$((attempt > max_attempts ? max_attempts : attempt))" --argjson elapsed "$((SECONDS - started))" '{diagnosticCode:"ALB_LISTENER_TIMEOUT",classification:"TRANSIENT_TIMEOUT",attempts:$attempts,elapsedSeconds:$elapsed}')"
  runtime_failure "$service_id" DG_ALB_LISTENER_MISMATCH alb_listener "The service ALB listener did not appear within the bounded convergence policy." "$diagnostic"
}

wait_for_public_dns() {
  local service_id="$1" hostname="$2" attempt started elapsed addresses diagnostic remaining effective_timeout
  local max_attempts="${DEPLOYGUARD_DNS_MAX_ATTEMPTS:-20}"
  local interval_seconds="${DEPLOYGUARD_DNS_INTERVAL_SECONDS:-3}"
  local max_elapsed_seconds="${DEPLOYGUARD_DNS_MAX_ELAPSED_SECONDS:-90}"
  local attempt_timeout_seconds="${DEPLOYGUARD_DNS_ATTEMPT_TIMEOUT_SECONDS:-5}"
  [[ "$max_attempts" =~ ^[1-9][0-9]*$ ]] && [ "$max_attempts" -le 120 ] || configuration_failure "$service_id" "DNS attempt limit is invalid."
  [[ "$interval_seconds" =~ ^[0-9]+$ ]] && [ "$interval_seconds" -le 30 ] || configuration_failure "$service_id" "DNS interval is invalid."
  [[ "$max_elapsed_seconds" =~ ^[1-9][0-9]*$ ]] && [ "$max_elapsed_seconds" -le 900 ] || configuration_failure "$service_id" "DNS elapsed-time limit is invalid."
  [[ "$attempt_timeout_seconds" =~ ^[1-9][0-9]*$ ]] && [ "$attempt_timeout_seconds" -le 30 ] || configuration_failure "$service_id" "DNS per-attempt timeout is invalid."
  command -v getent >/dev/null 2>&1 || configuration_failure "$service_id" "The runtime verifier requires getent for bounded public DNS verification."
  started="$SECONDS"
  resolved_ips='[]'
  for ((attempt=1; attempt<=max_attempts; attempt++)); do
    elapsed=$((SECONDS - started)); remaining=$((max_elapsed_seconds - elapsed)); [ "$remaining" -gt 0 ] || break
    effective_timeout="$attempt_timeout_seconds"; [ "$effective_timeout" -le "$remaining" ] || effective_timeout="$remaining"
    addresses="$(timeout "$effective_timeout" getent ahostsv4 "$hostname" 2>/dev/null | awk '{print $1}' | sort -u || true)"
    resolved_ips="$(printf '%s\n' "$addresses" | jq -Rsc 'split("\n") | map(select(length > 0)) | unique | sort')"
    if jq -e 'length > 0 and all(.[]; test("^[0-9]{1,3}(\\.[0-9]{1,3}){3}$"))' <<<"$resolved_ips" >/dev/null; then
      dns_attempt_count="$attempt"
      dns_elapsed_seconds="$((SECONDS - started))"
      return 0
    fi
    elapsed=$((SECONDS - started))
    [ "$attempt" -eq "$max_attempts" ] || sleep_within_deadline "$started" "$max_elapsed_seconds" "$interval_seconds" || break
    [ "$elapsed" -lt "$max_elapsed_seconds" ] || break
  done
  diagnostic="$(jq -cn --arg hostname "$hostname" --argjson addresses "$resolved_ips" --argjson attempts "$((attempt > max_attempts ? max_attempts : attempt))" --argjson elapsed "$((SECONDS - started))" '{diagnosticCode:"PUBLIC_DNS_UNRESOLVED",classification:"TRANSIENT_TIMEOUT",hostname:$hostname,resolvedIpAddresses:$addresses,attempts:$attempts,elapsedSeconds:$elapsed}')"
  runtime_failure "$service_id" DG_PUBLIC_DNS_UNRESOLVED public_dns "The public ALB DNS name did not resolve within the bounded convergence policy." "$diagnostic"
}

wait_for_public_transport() {
  local service_id="$1" public_url="$2" hostname="$3" attempt started elapsed metrics curl_exit http_status remote_ip connect_time start_transfer_time total_time stderr_file stderr_text classification failure_code summary diagnostic remaining effective_attempt_timeout effective_connect_timeout
  local max_attempts="${DEPLOYGUARD_PUBLIC_MAX_ATTEMPTS:-25}"
  local interval_seconds="${DEPLOYGUARD_PUBLIC_INTERVAL_SECONDS:-3}"
  local max_elapsed_seconds="${DEPLOYGUARD_PUBLIC_MAX_ELAPSED_SECONDS:-150}"
  local connect_timeout_seconds="${DEPLOYGUARD_PUBLIC_CONNECT_TIMEOUT_SECONDS:-5}"
  local attempt_timeout_seconds="${DEPLOYGUARD_PUBLIC_ATTEMPT_TIMEOUT_SECONDS:-10}"
  [[ "$max_attempts" =~ ^[1-9][0-9]*$ ]] && [ "$max_attempts" -le 120 ] || configuration_failure "$service_id" "Public-probe attempt limit is invalid."
  [[ "$interval_seconds" =~ ^[0-9]+$ ]] && [ "$interval_seconds" -le 30 ] || configuration_failure "$service_id" "Public-probe interval is invalid."
  [[ "$max_elapsed_seconds" =~ ^[1-9][0-9]*$ ]] && [ "$max_elapsed_seconds" -le 900 ] || configuration_failure "$service_id" "Public-probe elapsed-time limit is invalid."
  [[ "$connect_timeout_seconds" =~ ^[1-9][0-9]*$ ]] && [ "$connect_timeout_seconds" -le 30 ] || configuration_failure "$service_id" "Public-probe connection timeout is invalid."
  [[ "$attempt_timeout_seconds" =~ ^[1-9][0-9]*$ ]] && [ "$attempt_timeout_seconds" -le 60 ] || configuration_failure "$service_id" "Public-probe per-attempt timeout is invalid."
  stderr_file="$(mktemp)"
  trap 'rm -f "$stderr_file"' RETURN
  started="$SECONDS"
  curl_exit=0; http_status=000; remote_ip=""; connect_time=0; start_transfer_time=0; total_time=0; stderr_text=""
  for ((attempt=1; attempt<=max_attempts; attempt++)); do
    elapsed=$((SECONDS - started)); remaining=$((max_elapsed_seconds - elapsed)); [ "$remaining" -gt 0 ] || break
    effective_attempt_timeout="$attempt_timeout_seconds"; [ "$effective_attempt_timeout" -le "$remaining" ] || effective_attempt_timeout="$remaining"
    effective_connect_timeout="$connect_timeout_seconds"; [ "$effective_connect_timeout" -le "$effective_attempt_timeout" ] || effective_connect_timeout="$effective_attempt_timeout"
    : > "$stderr_file"
    if metrics="$(curl --silent --show-error --connect-timeout "$effective_connect_timeout" --max-time "$effective_attempt_timeout" --output /dev/null --write-out '%{http_code}\t%{remote_ip}\t%{time_connect}\t%{time_starttransfer}\t%{time_total}' "$public_url" 2>"$stderr_file")"; then curl_exit=0; else curl_exit=$?; fi
    IFS=$'\t' read -r http_status remote_ip connect_time start_transfer_time total_time <<<"$metrics"
    stderr_text="$(sanitize < "$stderr_file")"
    elapsed=$((SECONDS - started))
    if [ "$curl_exit" -eq 0 ] && [[ "$http_status" =~ ^[1-5][0-9][0-9]$ ]] && [[ ! "$http_status" =~ ^(502|503|504)$ ]]; then
      public_probe="$(jq -cn --arg hostname "$hostname" --argjson resolvedIpAddresses "$resolved_ips" --argjson dnsAttempts "$dns_attempt_count" --argjson dnsElapsedSeconds "$dns_elapsed_seconds" --argjson attemptCount "$attempt" --argjson elapsedSeconds "$elapsed" --argjson curlExitCode "$curl_exit" --arg httpStatus "$http_status" --arg remoteIp "$remote_ip" --arg connectTime "$connect_time" --arg startTransferTime "$start_transfer_time" --arg totalTime "$total_time" '{classification:"READY",hostname:$hostname,resolvedIpAddresses:$resolvedIpAddresses,dnsAttempts:$dnsAttempts,dnsElapsedSeconds:$dnsElapsedSeconds,attemptCount:$attemptCount,elapsedSeconds:$elapsedSeconds,curlExitCode:$curlExitCode,httpStatus:$httpStatus,remoteIp:$remoteIp,connectTimeSeconds:$connectTime,startTransferTimeSeconds:$startTransferTime,totalTimeSeconds:$totalTime}')"
      rm -f "$stderr_file"; trap - RETURN
      return 0
    fi
    [ "$attempt" -eq "$max_attempts" ] || sleep_within_deadline "$started" "$max_elapsed_seconds" "$interval_seconds" || break
    [ "$elapsed" -lt "$max_elapsed_seconds" ] || break
  done
  classification="TRANSIENT_TIMEOUT"; failure_code=DG_PUBLIC_CONNECTION_FAILED; summary="The public endpoint did not accept a connection within the bounded convergence policy."
  if [ "$curl_exit" -eq 6 ]; then failure_code=DG_PUBLIC_DNS_UNRESOLVED; summary="The public endpoint DNS name stopped resolving during bounded transport convergence."
  elif [ "$curl_exit" -eq 0 ] && [[ "$http_status" =~ ^(502|503|504)$ ]]; then failure_code=DG_PUBLIC_REACHABILITY_FAILED; summary="The ALB continued returning a gateway reachability failure after bounded convergence."; fi
  diagnostic="$(jq -cn --arg diagnosticCode "${failure_code#DG_}" --arg classification "$classification" --arg hostname "$hostname" --argjson resolvedIpAddresses "$resolved_ips" --argjson attemptCount "$((attempt > max_attempts ? max_attempts : attempt))" --argjson elapsedSeconds "$((SECONDS - started))" --argjson curlExitCode "$curl_exit" --arg httpStatus "$http_status" --arg remoteIp "$remote_ip" --arg connectTime "$connect_time" --arg startTransferTime "$start_transfer_time" --arg totalTime "$total_time" --arg curlStderr "$stderr_text" --argjson alb "$alb_observation" --argjson listener "$listener_observation" --argjson targets "$(jq '[.TargetHealthDescriptions[]? | {targetId:(.Target.Id//null),port:(.Target.Port//null),state:(.TargetHealth.State//null),reason:(.TargetHealth.Reason//null)}]' <<<"$target_health")" '{diagnosticCode:$diagnosticCode,classification:$classification,hostname:$hostname,resolvedIpAddresses:$resolvedIpAddresses,attemptCount:$attemptCount,elapsedSeconds:$elapsedSeconds,curlExitCode:$curlExitCode,httpStatus:$httpStatus,remoteIp:$remoteIp,connectTimeSeconds:$connectTime,startTransferTimeSeconds:$startTransferTime,totalTimeSeconds:$totalTime,curlStderr:$curlStderr,alb:$alb,listener:$listener,targetHealth:$targets}')"
  rm -f "$stderr_file"; trap - RETURN
  runtime_failure "$service_id" "$failure_code" public_health "$summary" "$diagnostic"
}

managed_database_failure() {
  local service_id="$1" code="$2" summary="$3" diagnostic="$4"
  echo "DG_FAILURE serviceId=$service_id code=$code stage=managed_database_readiness" >&2
  append_outcome "$service_id" false "$code" "$summary" managed_database_readiness
  attach_diagnostics "$service_id" "$diagnostic" || true
  printf '%s\n' "$diagnostic" | sanitize | sed 's/^/DG_DATABASE_DIAGNOSTICS /' >&2 || true
  return 1
}

wait_for_managed_database_readiness() {
  local service_id="$1" cluster="$2" service_name="$3" task_definition="$4" engine="$5"
  local max_attempts="${DEPLOYGUARD_DATABASE_READINESS_MAX_ATTEMPTS:-60}"
  local interval_seconds="${DEPLOYGUARD_DATABASE_READINESS_INTERVAL_SECONDS:-5}"
  local max_elapsed_seconds="${DEPLOYGUARD_DATABASE_READINESS_MAX_ELAPSED_SECONDS:-360}"
  local attempt task_arns tasks last_observation diagnostic started elapsed remaining observation_status
  [[ "$engine" =~ ^(postgres|mysql|mongodb)$ ]] || configuration_failure "$service_id" "Managed database engine is invalid."
  [[ "$max_attempts" =~ ^[1-9][0-9]*$ ]] && [ "$max_attempts" -le 120 ] || configuration_failure "$service_id" "Managed database readiness attempt limit is invalid."
  [[ "$interval_seconds" =~ ^[0-9]+$ ]] && [ "$interval_seconds" -le 30 ] || configuration_failure "$service_id" "Managed database readiness interval is invalid."
  [[ "$max_elapsed_seconds" =~ ^[1-9][0-9]*$ ]] && [ "$max_elapsed_seconds" -le 1200 ] || configuration_failure "$service_id" "Managed database readiness elapsed-time limit is invalid."

  last_observation='{"tasks":[]}'
  started="$SECONDS"
  for ((attempt=1; attempt<=max_attempts; attempt++)); do
    elapsed=$((SECONDS - started)); remaining=$((max_elapsed_seconds - elapsed)); [ "$remaining" -gt 0 ] || break
    if task_arns="$(timeout "$remaining" aws ecs list-tasks --cluster "$cluster" --service-name "$service_name" --desired-status RUNNING --output json 2>&1)"; then observation_status=0; else observation_status=$?; fi
    [ "$observation_status" -ne 124 ] || break
    [ "$observation_status" -eq 0 ] || provider_failure "$service_id" "$task_arns"
    jq -e '.taskArns | type == "array"' <<<"$task_arns" >/dev/null 2>&1 || provider_failure "$service_id" "$task_arns"
    if [ "$(jq '.taskArns | length' <<<"$task_arns")" -gt 0 ]; then
      mapfile -t running_task_arns < <(jq -r '.taskArns[]' <<<"$task_arns")
      elapsed=$((SECONDS - started)); remaining=$((max_elapsed_seconds - elapsed)); [ "$remaining" -gt 0 ] || break
      if tasks="$(timeout "$remaining" aws ecs describe-tasks --cluster "$cluster" --tasks "${running_task_arns[@]}" --output json 2>&1)"; then observation_status=0; else observation_status=$?; fi
      [ "$observation_status" -ne 124 ] || break
      [ "$observation_status" -eq 0 ] || provider_failure "$service_id" "$tasks"
      jq -e '.tasks | type == "array"' <<<"$tasks" >/dev/null 2>&1 || provider_failure "$service_id" "$tasks"
    else
      tasks='{"tasks":[]}'
    fi

    last_observation="$(jq -c --arg taskDefinition "$task_definition" '
      {tasks:[.tasks[]? | select(.taskDefinitionArn == $taskDefinition) | {
        lastStatus:(.lastStatus // null), healthStatus:(.healthStatus // null), stopCode:(.stopCode // null),
        databaseContainer:([.containers[]? | select(.name == "database") | {lastStatus:(.lastStatus // null),healthStatus:(.healthStatus // null),exitCode:(.exitCode // null)}] | first // null),
        mysqlGrantReconciler:([.containers[]? | select(.name == "deployguard-mysql-grant-reconciler") | {lastStatus:(.lastStatus // null),exitCode:(.exitCode // null),reason:(.reason // null)}] | first // null)
      }]}
    ' <<<"$tasks")" || configuration_failure "$service_id" "Managed database task evidence is invalid."

    if [ "$engine" = mysql ] && jq -e --arg taskDefinition "$task_definition" '
      any(.tasks[]?; .taskDefinitionArn == $taskDefinition and any(.containers[]?; .name == "deployguard-mysql-grant-reconciler" and .lastStatus == "STOPPED" and (.exitCode // 1) != 0))
    ' <<<"$tasks" >/dev/null; then
      diagnostic="$(jq -cn --argjson observation "$last_observation" '{diagnosticCode:"MANAGED_MYSQL_GRANT_RECONCILIATION_FAILED",observation:$observation}')" || configuration_failure "$service_id" "Managed MySQL grant evidence is invalid."
      managed_database_failure "$service_id" DG_MANAGED_MYSQL_GRANT_RECONCILIATION_FAILED "Managed MySQL host-grant reconciliation failed." "$diagnostic"
      return 1
    fi

    if jq -e --arg taskDefinition "$task_definition" --arg engine "$engine" '
      any(.tasks[]?;
        .taskDefinitionArn == $taskDefinition
        and .lastStatus == "RUNNING"
        and .healthStatus == "HEALTHY"
        and any(.containers[]?; .name == "database" and .lastStatus == "RUNNING" and .healthStatus == "HEALTHY")
        and ($engine != "mysql" or any(.containers[]?; .name == "deployguard-mysql-grant-reconciler" and .lastStatus == "STOPPED" and .exitCode == 0))
      )
    ' <<<"$tasks" >/dev/null; then
      printf 'DG_MANAGED_DATABASE_READY serviceId=%s engine=%s attempts=%s\n' "$service_id" "$engine" "$attempt"
      return 0
    fi
    [ "$attempt" -eq "$max_attempts" ] || sleep_within_deadline "$started" "$max_elapsed_seconds" "$interval_seconds" || break
  done

  diagnostic="$(jq -cn --arg engine "$engine" --argjson attempts "$((attempt > max_attempts ? max_attempts : attempt))" --argjson elapsed "$((SECONDS - started))" --argjson observation "$last_observation" '{diagnosticCode:"MANAGED_DATABASE_READINESS_TIMEOUT",classification:"TRANSIENT_TIMEOUT",engine:$engine,attempts:$attempts,elapsedSeconds:$elapsed,observation:$observation}')" || configuration_failure "$service_id" "Managed database timeout evidence is invalid."
  managed_database_failure "$service_id" DG_MANAGED_DATABASE_READINESS_FAILED "Managed database did not become ready within the bounded policy." "$diagnostic"
  return 1
}

wait_for_cloud_map_registration() {
  local service_id="$1" cloud_map_service_id="$2" expected_ips="$3" attempt started elapsed detail diagnostic remaining observation_status
  local max_attempts="${DEPLOYGUARD_CLOUD_MAP_MAX_ATTEMPTS:-30}"
  local interval_seconds="${DEPLOYGUARD_CLOUD_MAP_INTERVAL_SECONDS:-3}"
  local max_elapsed_seconds="${DEPLOYGUARD_CLOUD_MAP_MAX_ELAPSED_SECONDS:-120}"
  [[ "$max_attempts" =~ ^[1-9][0-9]*$ ]] && [ "$max_attempts" -le 120 ] || configuration_failure "$service_id" "Cloud Map attempt limit is invalid."
  [[ "$interval_seconds" =~ ^[0-9]+$ ]] && [ "$interval_seconds" -le 30 ] || configuration_failure "$service_id" "Cloud Map interval is invalid."
  [[ "$max_elapsed_seconds" =~ ^[1-9][0-9]*$ ]] && [ "$max_elapsed_seconds" -le 900 ] || configuration_failure "$service_id" "Cloud Map elapsed-time limit is invalid."
  started="$SECONDS"
  cloud_map_observation='{"registeredIpAddresses":[]}'
  for ((attempt=1; attempt<=max_attempts; attempt++)); do
    elapsed=$((SECONDS - started)); remaining=$((max_elapsed_seconds - elapsed)); [ "$remaining" -gt 0 ] || break
    if detail="$(timeout "$remaining" aws servicediscovery list-instances --service-id "$cloud_map_service_id" --output json 2>&1)"; then observation_status=0; else observation_status=$?; fi
    [ "$observation_status" -ne 124 ] || break
    [ "$observation_status" -eq 0 ] || provider_failure "$service_id" "$detail"
    cloud_map_observation="$(jq -c '{registeredIpAddresses:([.Instances[]?.Attributes.AWS_INSTANCE_IPV4 | select(type == "string" and length > 0)] | unique | sort)}' <<<"$detail")" || configuration_failure "$service_id" "Cloud Map instance evidence is invalid."
    if jq -e --argjson expected "$expected_ips" '(.registeredIpAddresses | sort) == ($expected | sort)' <<<"$cloud_map_observation" >/dev/null; then
      cloud_map_observation="$(jq -c --argjson attempts "$attempt" --argjson elapsed "$((SECONDS - started))" '. + {classification:"READY",attempts:$attempts,elapsedSeconds:$elapsed}' <<<"$cloud_map_observation")"
      return 0
    fi
    elapsed=$((SECONDS - started))
    [ "$attempt" -eq "$max_attempts" ] || sleep_within_deadline "$started" "$max_elapsed_seconds" "$interval_seconds" || break
    [ "$elapsed" -lt "$max_elapsed_seconds" ] || break
  done
  diagnostic="$(jq -cn --argjson expectedIpAddresses "$expected_ips" --argjson observation "$cloud_map_observation" --argjson attempts "$((attempt > max_attempts ? max_attempts : attempt))" --argjson elapsed "$((SECONDS - started))" '{diagnosticCode:"CLOUD_MAP_REGISTRATION_TIMEOUT",classification:"TRANSIENT_TIMEOUT",expectedIpAddresses:$expectedIpAddresses,observation:$observation,attempts:$attempts,elapsedSeconds:$elapsed}')"
  managed_database_failure "$service_id" DG_CLOUD_MAP_REGISTRATION_TIMEOUT "Managed database Cloud Map registration did not converge to the current task identity." "$diagnostic"
  return 1
}

release_database_attached_service() {
  local service_id="$1" cluster="$2" attached_service="$3" update
  update="$(aws ecs update-service --cluster "$cluster" --service "$attached_service" --desired-count 1 --output json 2>&1)" || provider_failure "$service_id" "$update"
  jq -e --arg service "$attached_service" '.service.serviceName == $service and .service.desiredCount == 1' <<<"$update" >/dev/null || configuration_failure "$service_id" "The attached application service did not accept its intended desired count."
  printf 'DG_DATABASE_ATTACHED_SERVICE_RELEASED serviceId=%s desiredCount=1\n' "$service_id"
}

cluster="$(jq -r '.ecs_cluster_name' "$outputs")"
expected_subnets="$(jq -c 'map(gsub("^\\s+|\\s+$"; "")) | sort' <<<"$(jq -c '.public_subnet_ids // []' "$outputs")")"

database_service="$(jq -r '.database.ecs_service_name // empty' "$outputs")"
database_id="$(jq -r '.database.attached_service_id // empty' "$outputs")"
verify_database() {
  database_id="$(jq -r '.database.attached_service_id' "$outputs")"
  database_task_definition="$(jq -r '.database.task_definition_arn' "$outputs")"
  database_engine="$(jq -r '.database.engine' "$outputs")"
  wait_for_managed_database_readiness "$database_id" "$cluster" "$database_service" "$database_task_definition" "$database_engine" || return 1
  database_description="$(aws ecs describe-services --cluster "$cluster" --services "$database_service" --output json 2>&1)" || provider_failure "$database_id" "$database_description"
  database_task="$(aws ecs list-tasks --cluster "$cluster" --service-name "$database_service" --desired-status RUNNING --output json 2>&1)" || provider_failure "$database_id" "$database_task"
  cloud_map_service="$(jq -r '.database.cloud_map_service_id' "$outputs")"
  cloud_map="$(aws servicediscovery get-service --id "$cloud_map_service" --output json 2>&1)" || provider_failure "$database_id" "$cloud_map"
  database_sg="$(jq -r '.database.security_group_id' "$outputs")"
  application_sg="$(jq -r '.services[.database.attached_service_id].security_group_id' "$outputs")"
  security_group="$(aws ec2 describe-security-groups --group-ids "$database_sg" --output json 2>&1)" || provider_failure "$database_id" "$security_group"
  database_port="$(jq -r '.database.port' "$outputs")"
  jq -e --arg task "$database_task_definition" --arg registry "$(jq -r '.database.cloud_map_service_arn' "$outputs")" '
    .services[0].status == "ACTIVE" and .services[0].taskDefinition == $task and (.services[0].serviceRegistries | map(.registryArn) | index($registry) != null)
  ' <<<"$database_description" >/dev/null || configuration_failure "$database_id" "Managed database ECS or Cloud Map runtime identity does not match Terraform."
  jq -e '.taskArns | length > 0' <<<"$database_task" >/dev/null || configuration_failure "$database_id" "Managed database has no running ECS task."
  jq -e '.Service.Type == "DNS_HTTP"' <<<"$cloud_map" >/dev/null || configuration_failure "$database_id" "Cloud Map service is not DNS-enabled."
  mapfile -t database_task_arns < <(jq -r '.taskArns[]' <<<"$database_task")
  database_tasks="$(aws ecs describe-tasks --cluster "$cluster" --tasks "${database_task_arns[@]}" --output json 2>&1)" || provider_failure "$database_id" "$database_tasks"
  database_task_ips="$(jq -c --arg taskDefinition "$database_task_definition" '[.tasks[]? | select(.taskDefinitionArn == $taskDefinition and .lastStatus == "RUNNING") | .attachments[]?.details[]? | select(.name == "privateIPv4Address") | .value] | unique | sort' <<<"$database_tasks")" || configuration_failure "$database_id" "Managed database task-network evidence is invalid."
  jq -e 'length > 0' <<<"$database_task_ips" >/dev/null || configuration_failure "$database_id" "Managed database has no current task ENI identity."
  wait_for_cloud_map_registration "$database_id" "$cloud_map_service" "$database_task_ips" || return 1
  jq -e --arg vpc "$(jq -r '.vpc_id' "$outputs")" --arg application "$application_sg" --argjson port "$database_port" '
    .SecurityGroups[0].VpcId == $vpc and any(.SecurityGroups[0].IpPermissions[]; .FromPort == $port and .ToPort == $port and any(.UserIdGroupPairs[]; .GroupId == $application))
  ' <<<"$security_group" >/dev/null || configuration_failure "$database_id" "Managed database security group does not admit only its attached application service on the database port."
  attached_service="$(jq -r --arg id "$database_id" '.services[$id].ecs_service_name // empty' "$outputs")"
  [ -n "$attached_service" ] || configuration_failure "$database_id" "Managed database attachment does not resolve to an application ECS service."
  release_database_attached_service "$database_id" "$cluster" "$attached_service"
}

database_failed=false
if [ -n "$database_service" ] && ! (verify_database); then
  database_failed=true
fi

verify_service() {
  local service="$1" service_id deployed expected service_name target_group log_group service_description task_definition_arn task_definition expected_image expected_port expected_probe_port expected_health_path
  local database expected_environment expected_secrets managed_database application_sg alb_sg application_security_group alb_security_group target_group_description running tasks target_health expected_targets check
  local target_result alb_arn public_url public_host ecs_stability_timeout_seconds
  local -a running_task_arns
  service_id="$(jq -r '.key' <<<"$service")"; deployed="$(jq -c '.value' <<<"$service")"
  expected="$(jq -c --arg id "$service_id" '.services[] | select(.serviceId == $id)' "$runtime")"
  service_name="$(jq -r '.ecs_service_name' <<<"$deployed")"; target_group="$(jq -r '.alb_target_group_arn' <<<"$deployed")"; log_group="$(jq -r '.cloudwatch_log_group_name' <<<"$deployed")"
  service_description="$(aws ecs describe-services --cluster "$cluster" --services "$service_name" --output json 2>&1)" || provider_failure "$service_id" "$service_description"
  task_definition_arn="$(jq -r '.task_definition_arn' <<<"$deployed")"
  task_definition="$(aws ecs describe-task-definition --task-definition "$task_definition_arn" --output json 2>&1)" || provider_failure "$service_id" "$task_definition"
  expected_image="$(jq -r '.image' <<<"$deployed")"
  expected_port="$(jq -r '.servicePort' <<<"$expected")"
  expected_probe_port="$(jq -r '.transport_probe_port' <<<"$deployed")"
  expected_health_path="$(jq -r '.platform_health_check_path' <<<"$deployed")"
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
  jq -e --arg image "$expected_image" --arg log "$log_group" --arg probeImage "public.ecr.aws/docker/library/busybox:1.36.1@sha256:73aaf090f3d85aa34ee199857f03fa3a95c8ede2ffd4cc2cdb5b94e566b11662" --argjson port "$expected_port" --argjson probePort "$expected_probe_port" --argjson secrets "$expected_secrets" --argjson environment "$expected_environment" '
    (.taskDefinition.containerDefinitions | map(select(.name == "application")) | first) as $app |
    (.taskDefinition.containerDefinitions | map(select(.name == "deployguard-transport-probe")) | first) as $probe |
    $app.image == $image and ($app.portMappings | any(.containerPort == $port and .hostPort == $port)) and $app.logConfiguration.options["awslogs-group"] == $log
    and ([$app.secrets[]? | {key:.name,value:.valueFrom}] | from_entries) == $secrets
    and ([$app.environment[]? | {key:.name,value:.value}] | from_entries) == $environment
    and $probe.essential == true and $probe.image == $probeImage
    and ($probe.portMappings | any(.containerPort == $probePort and .hostPort == $probePort))
    and ([$probe.environment[]? | {key:.name,value:.value}] | from_entries) == {APPLICATION_PORT:($port|tostring),PROBE_PORT:($probePort|tostring)}
  ' <<<"$task_definition" >/dev/null || configuration_failure "$service_id" "Task definition image, port, log, environment, or Secrets Manager injection does not match the immutable runtime."
  application_sg="$(jq -r '.security_group_id' <<<"$deployed")"
  alb_sg="$(jq -r '.alb_security_group_id' <<<"$deployed")"
  application_security_group="$(aws ec2 describe-security-groups --group-ids "$application_sg" --output json 2>&1)" || provider_failure "$service_id" "$application_security_group"
  jq -e --arg vpc "$(jq -r '.vpc_id' "$outputs")" --arg alb "$alb_sg" --argjson port "$expected_port" --argjson probePort "$expected_probe_port" --argjson root "$application_security_group" '.SecurityGroups[0].VpcId == $vpc and all([$port,$probePort][]; . as $required | any($root.SecurityGroups[0].IpPermissions[]; .FromPort == $required and .ToPort == $required and any(.UserIdGroupPairs[]; .GroupId == $alb)))' <<<"$application_security_group" >/dev/null || configuration_failure "$service_id" "Application security group does not admit the service ALB on the immutable application and transport-probe ports."
  alb_security_group="$(aws ec2 describe-security-groups --group-ids "$alb_sg" --output json 2>&1)" || provider_failure "$service_id" "$alb_security_group"
  jq -e --arg vpc "$(jq -r '.vpc_id' "$outputs")" '.SecurityGroups[0].VpcId == $vpc and any(.SecurityGroups[0].IpPermissions[]; .IpProtocol == "tcp" and .FromPort == 80 and .ToPort == 80 and any(.IpRanges[]?; .CidrIp == "0.0.0.0/0"))' <<<"$alb_security_group" >/dev/null || configuration_failure "$service_id" "ALB security group does not admit public IPv4 HTTP traffic on port 80."
  target_group_description="$(aws elbv2 describe-target-groups --target-group-arns "$target_group" --output json 2>&1)" || provider_failure "$service_id" "$target_group_description"
  jq -e --arg vpc "$(jq -r '.vpc_id' "$outputs")" --argjson port "$expected_port" --arg probePort "$expected_probe_port" --arg path "$expected_health_path" '.TargetGroups[0].VpcId == $vpc and .TargetGroups[0].Port == $port and .TargetGroups[0].Protocol == "HTTP" and .TargetGroups[0].HealthCheckPort == $probePort and .TargetGroups[0].HealthCheckPath == $path and .TargetGroups[0].Matcher.HttpCode == "200-299"' <<<"$target_group_description" >/dev/null || configuration_failure "$service_id" "ALB target group does not use the immutable application port and platform transport-readiness probe."
  ecs_stability_timeout_seconds="${DEPLOYGUARD_ECS_STABILITY_TIMEOUT_SECONDS:-660}"
  [[ "$ecs_stability_timeout_seconds" =~ ^[1-9][0-9]*$ ]] && [ "$ecs_stability_timeout_seconds" -le 1200 ] || configuration_failure "$service_id" "ECS stability timeout is invalid."
  timeout "$ecs_stability_timeout_seconds" aws ecs wait services-stable --cluster "$cluster" --services "$service_name" || ecs_diagnostics "$service_id" "$cluster" "$service_name" "$target_group" "$log_group"
  running="$(aws ecs list-tasks --cluster "$cluster" --service-name "$service_name" --desired-status RUNNING --output json 2>&1)" || provider_failure "$service_id" "$running"
  jq -e '.taskArns | length > 0' <<<"$running" >/dev/null || ecs_diagnostics "$service_id" "$cluster" "$service_name" "$target_group" "$log_group"
  mapfile -t running_task_arns < <(jq -r '.taskArns[]' <<<"$running")
  tasks="$(aws ecs describe-tasks --cluster "$cluster" --tasks "${running_task_arns[@]}" --output json 2>&1)" || provider_failure "$service_id" "$tasks"
  jq -e --arg task "$task_definition_arn" 'all(.tasks[]; .lastStatus == "RUNNING" and .taskDefinitionArn == $task and any(.containers[]; .name == "application" and .lastStatus == "RUNNING"))' <<<"$tasks" >/dev/null || ecs_diagnostics "$service_id" "$cluster" "$service_name" "$target_group" "$log_group"
  expected_targets="$(jq -c '[.tasks[]?.attachments[]?.details[]? | select(.name == "privateIPv4Address") | .value] | sort | unique' <<<"$tasks")"
  jq -e 'length > 0' <<<"$expected_targets" >/dev/null || ecs_diagnostics "$service_id" "$cluster" "$service_name" "$target_group" "$log_group"
  if wait_for_target_health "$service_id" "$target_group" "$expected_targets" "$expected_port"; then target_result=0; else target_result=$?; fi
  if [ "$target_result" -eq 2 ]; then
    runtime_failure "$service_id" DG_ECS_STABILITY_FAILED ecs_stability "An unexpected non-draining target is registered with the immutable service." "$(jq -cn --argjson expected "$expected_targets" --argjson observed "$(jq '[.TargetHealthDescriptions[]? | {targetId:(.Target.Id//null),port:(.Target.Port//null),state:(.TargetHealth.State//null),reason:(.TargetHealth.Reason//null)}]' <<<"$target_health")" '{diagnosticCode:"UNEXPECTED_ACTIVE_TARGET",classification:"FATAL",expectedTargetIds:$expected,targetHealth:$observed}')"
  elif [ "$target_result" -ne 0 ]; then
    ecs_diagnostics "$service_id" "$cluster" "$service_name" "$target_group" "$log_group"
  fi
  alb_arn="$(jq -r '.alb_arn' <<<"$deployed")"
  public_url="$(jq -r '.public_url' <<<"$deployed")"
  [[ "$public_url" =~ ^http://[A-Za-z0-9.-]+/?$ ]] || configuration_failure "$service_id" "The public ALB URL is not a canonical credential-free HTTP endpoint."
  public_host="${public_url#http://}"; public_host="${public_host%/}"
  wait_for_alb_active "$service_id" "$alb_arn" "$alb_sg"
  [ "$(jq -r '.dnsName' <<<"$alb_observation")" = "$public_host" ] || configuration_failure "$service_id" "The active ALB DNS identity does not match the immutable public endpoint."
  wait_for_listener "$service_id" "$alb_arn" "$target_group"
  wait_for_public_dns "$service_id" "$public_host"
  wait_for_public_transport "$service_id" "$public_url" "$public_host"
  check="$(jq -cn \
    --arg serviceId "$service_id" \
    --arg checkedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --arg image "$expected_image" \
    --arg ecsServiceArn "$(jq -r '.ecs_service_arn' <<<"$deployed")" \
    --arg taskDefinitionArn "$task_definition_arn" \
    --arg targetGroupArn "$target_group" \
    --arg publicUrl "$(jq -r '.public_url' <<<"$deployed")" \
    --argjson runningTaskArns "$(jq '.taskArns' <<<"$running")" \
    --argjson expectedTargets "$expected_targets" \
    --argjson targets "$(jq --argjson expected "$expected_targets" '[.TargetHealthDescriptions[] | select(.Target.Id as $id | $expected | index($id)) | .TargetHealth.State]' <<<"$target_health")" \
    --argjson targetRegistrations "$(jq '[.TargetHealthDescriptions[] | {targetId:.Target.Id,port:(.Target.Port//null),state:.TargetHealth.State}]' <<<"$target_health")" \
    --argjson environment "$expected_environment" \
    --argjson secretValueFrom "$expected_secrets" \
    --argjson managedDatabase "$managed_database" \
    --argjson runtimePort "$expected_port" \
    --argjson transportProbePort "$expected_probe_port" \
    --arg platformHealthCheckPath "$expected_health_path" \
    --argjson alb "$alb_observation" \
    --argjson listener "$listener_observation" \
    --argjson publicProbe "$public_probe" \
    '{serviceId:$serviceId,verified:true,readinessMode:"platform_transport",applicationReachabilityPath:"alb_to_task_eni",image:$image,ecsServiceArn:$ecsServiceArn,taskDefinitionArn:$taskDefinitionArn,runningTaskArns:$runningTaskArns,ecsTasksRunning:($runningTaskArns|length),taskIpAddresses:$expectedTargets,runtimePort:$runtimePort,transportProbePort:$transportProbePort,platformHealthCheckPath:$platformHealthCheckPath,targetGroupArn:$targetGroupArn,targetHealth:$targets,targetRegistrations:$targetRegistrations,alb:$alb,listener:$listener,publicProbe:$publicProbe,environment:$environment,secretValueFrom:$secretValueFrom,managedDatabase:$managedDatabase,publicUrl:$publicUrl,publicEndpointVerified:true,taskDefinition:true,secretsInjection:true,vpcConnectivity:true,publicReachability:true,checkedAt:$checkedAt}')"
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
