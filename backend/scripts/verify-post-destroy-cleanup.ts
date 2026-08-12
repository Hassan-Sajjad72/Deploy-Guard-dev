import { strict as assert } from "assert";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { spawnSync } from "child_process";

const workflow = readFileSync(resolve(__dirname, "../../.github/workflows/deployguard-reusable.yml"), "utf8");
const cleanup = workflow.match(/      - name: Run generation-scoped AWS scavenger[\s\S]*?        run: \|\n([\s\S]*?)\n      - name: Verify ALB health and write result/)?.[1];
assert.ok(cleanup, "post-Destroy cleanup step must remain extractable for regression execution");

const directory = mkdtempSync(join(tmpdir(), "deployguard-destroy-cleanup-"));
const script = join(directory, "cleanup.sh");
const aws = join(directory, "aws");
const calls = join(directory, "calls.log");
const projectId = "b713ea5b-589b-4ab4-8175-6af7dc2ed402";
const generationId = "404cd3c1-a7dd-4b26-85e9-f531b3cb7ef1";

writeFileSync(script, cleanup!.split("\n").map((line) => line.slice(10)).join("\n"));
writeFileSync(aws, `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$CALLS_FILE"
service="$1"; operation="$2"
if [ "$service:$operation" = "secretsmanager:describe-secret" ]; then
  case "$SCENARIO" in
    absent|partial) echo 'ResourceNotFoundException' >&2; exit 255 ;;
    other-secret) generation='00000000-0000-4000-8000-000000000000' ;;
    *) generation="$GENERATION_ID" ;;
  esac
  jq -cn --arg name "deployguard/$PROJECT_ID/$ENVIRONMENT_NAME/$GENERATION_ID/application/runtime" --arg project "$PROJECT_ID" --arg environment "$ENVIRONMENT_NAME" --arg generation "$generation" '{Name:$name,Tags:[{Key:"ManagedBy",Value:"DeployGuard"},{Key:"DeployGuardProjectId",Value:$project},{Key:"Environment",Value:$environment},{Key:"DeployGuardGenerationId",Value:$generation},{Key:"SecretPurpose",Value:"application_runtime"}]}'
  exit 0
fi
if [ "$service:$operation" = "secretsmanager:delete-secret" ]; then
  [ "$SCENARIO" != "delete-failure" ] || { echo 'AccessDeniedException' >&2; exit 255; }
  echo '{}'; exit 0
fi
if [ "$service:$operation" = "ecs:list-task-definitions" ]; then
  [ "$SCENARIO" != "list-failure" ] || { echo 'AccessDeniedException' >&2; exit 255; }
  case "$SCENARIO" in
    owned-task|other-task) echo "arn:aws:ecs:us-east-1:123456789012:task-definition/$RESOURCE_NAME:7" ;;
  esac
  exit 0
fi
if [ "$service:$operation" = "ecs:list-tags-for-resource" ]; then
  [ "$SCENARIO" = "other-task" ] && generation='00000000-0000-4000-8000-000000000000' || generation="$GENERATION_ID"
  jq -cn --arg project "$PROJECT_ID" --arg environment "$ENVIRONMENT_NAME" --arg generation "$generation" '{tags:[{key:"ManagedBy",value:"DeployGuard"},{key:"DeployGuardProjectId",value:$project},{key:"Environment",value:$environment},{key:"DeployGuardGenerationId",value:$generation}]}'
  exit 0
fi
if [ "$service:$operation" = "ecs:deregister-task-definition" ]; then echo '{}'; exit 0; fi
if [ "$service:$operation" = "ecr:describe-repositories" ]; then
  case "$SCENARIO" in absent) echo 'RepositoryNotFoundException' >&2; exit 255;; esac
  jq -cn '{repositories:[{repositoryArn:"arn:aws:ecr:us-east-1:123456789012:repository/deployguard-test"}]}'
  exit 0
fi
if [ "$service:$operation" = "ecr:list-tags-for-resource" ]; then
  case "$SCENARIO" in
    other-ecr) generation='00000000-0000-4000-8000-000000000000' ;;
    legacy-ecr) generation='' ;;
    *) generation="$GENERATION_ID" ;;
  esac
  if [ -n "$generation" ]; then
    jq -cn --arg project "$PROJECT_ID" --arg environment "$ENVIRONMENT_NAME" --arg generation "$generation" '{tags:[{Key:"ManagedBy",Value:"DeployGuard"},{Key:"DeployGuardProjectId",Value:$project},{Key:"Environment",Value:$environment},{Key:"DeployGuardGenerationId",Value:$generation}]}'
  else
    jq -cn --arg project "$PROJECT_ID" --arg environment "$ENVIRONMENT_NAME" '{tags:[{Key:"ManagedBy",Value:"DeployGuard"},{Key:"DeployGuardProjectId",Value:$project},{Key:"Environment",Value:$environment}]}'
  fi
  exit 0
fi
if [ "$service:$operation" = "ecr:tag-resource" ] || [ "$service:$operation" = "ecr:delete-repository" ]; then echo '{}'; exit 0; fi
echo "Unexpected aws call: $*" >&2
exit 64
`);
chmodSync(script, 0o755);
chmodSync(aws, 0o755);

function run(scenario: string) {
  writeFileSync(calls, "");
  const result = spawnSync("bash", [script], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${directory}:${process.env.PATH || ""}`,
      CALLS_FILE: calls,
      SCENARIO: scenario,
      PROJECT_ID: projectId,
      ENVIRONMENT_NAME: "dev",
      GENERATION_ID: generationId,
      RESOURCE_NAME: `dg-${projectId.slice(0, 8)}-${generationId.slice(0, 8)}`,
    },
  });
  return { ...result, calls: readFileSync(calls, "utf8") };
}

try {
  const absent = run("absent");
  assert.equal(absent.status, 0, absent.stderr);
  assert.doesNotMatch(absent.calls, /delete-secret|delete-repository/, "already-absent resources require no mutation");

  const partial = run("partial");
  assert.equal(partial.status, 0, partial.stderr);
  assert.doesNotMatch(partial.calls, /delete-secret/, "an already-absent secret stays successful on retry");
  assert.match(partial.calls, /ecr delete-repository/, "a partial retry completes remaining ECR cleanup");

  const owned = run("owned");
  assert.equal(owned.status, 0, owned.stderr);
  assert.match(owned.calls, /secretsmanager delete-secret/);
  assert.match(owned.calls, /ecr delete-repository/);

  const ownedTask = run("owned-task");
  assert.equal(ownedTask.status, 0, ownedTask.stderr);
  assert.match(ownedTask.calls, new RegExp(`ecs list-task-definitions --family-prefix dg-${projectId.slice(0, 8)}-${generationId.slice(0, 8)} `), "cleanup uses the generation-qualified task family");
  assert.match(ownedTask.calls, /ecs deregister-task-definition/, "current-generation task definitions are deregistered");

  const otherTask = run("other-task");
  assert.equal(otherTask.status, 0, otherTask.stderr);
  assert.doesNotMatch(otherTask.calls, /ecs deregister-task-definition/, "another generation's task definition is untouched");

  const otherSecret = run("other-secret");
  assert.equal(otherSecret.status, 0);
  assert.doesNotMatch(otherSecret.calls, /delete-secret/, "cross-generation secret is untouched");
  assert.match(otherSecret.calls, /ecr delete-repository/, "a foreign secret does not suppress independent ECR cleanup");

  const otherEcr = run("other-ecr");
  assert.equal(otherEcr.status, 0);
  assert.doesNotMatch(otherEcr.calls, /ecr delete-repository/, "another generation's ECR repository is never deleted");

  const legacyEcr = run("legacy-ecr");
  assert.equal(legacyEcr.status, 0);
  assert.doesNotMatch(legacyEcr.calls, /ecr tag-resource|ecr delete-repository/, "unscoped legacy ECR is quarantined for explicit reconciliation, never adopted during Destroy");

  const deletionFailure = run("delete-failure");
  assert.equal(deletionFailure.status, 0);
  assert.match(deletionFailure.calls, /ecr delete-repository/, "a real secret deletion failure does not suppress independent cleanup");

  const listFailure = run("list-failure");
  assert.equal(listFailure.status, 0);
  assert.match(listFailure.calls, /ecr delete-repository/, "an inventory failure does not suppress independent cleanup");
} finally {
  rmSync(directory, { recursive: true, force: true });
}

console.log("Post-Destroy cleanup checks passed: idempotent absence, partial retry, generation ownership, and fail-closed deletion errors.");
