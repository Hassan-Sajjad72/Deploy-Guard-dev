import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

// This observer does not destroy anything and does not emit a destroy-result/v2.
// Its manifest must come from retained pre-destroy ownership evidence, never an
// empty post-destroy state or a broad tag-discovery result.
const VERSION = "deployguard.aws-deletion-manifest/v1";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const own = (value) => value && typeof value === "object" && !Array.isArray(value);
const text = (value) => typeof value === "string" && value.length > 0 && value.length <= 2048 && !/[\r\n\0]/.test(value) && !value.startsWith("-");
const absentErrors = {
  aws_security_group: ["InvalidGroup.NotFound"],
  aws_lb: ["LoadBalancerNotFound"], aws_lb_listener: ["ListenerNotFound"], aws_lb_target_group: ["TargetGroupNotFound"],
  aws_efs_file_system: ["FileSystemNotFound"], aws_efs_access_point: ["AccessPointNotFound"], aws_efs_mount_target: ["MountTargetNotFound"],
  aws_secretsmanager_secret: ["ResourceNotFoundException"], aws_iam_role: ["NoSuchEntity"],
  aws_service_discovery_service: ["ServiceNotFound"], aws_service_discovery_private_dns_namespace: ["NamespaceNotFound"],
  aws_ecr_repository: ["RepositoryNotFoundException"], s3_state_object: ["404", "NotFound", "NoSuchKey"],
};
const commands = {
  aws_ecs_cluster: (r) => ["ecs", "describe-clusters", "--clusters", r.id],
  aws_ecs_service: (r) => ["ecs", "describe-services", "--cluster", r.parent, "--services", r.id],
  aws_ecs_task_definition: (r) => ["ecs", "describe-task-definition", "--task-definition", r.id],
  aws_security_group: (r) => ["ec2", "describe-security-groups", "--group-ids", r.id],
  aws_lb: (r) => ["elbv2", "describe-load-balancers", "--load-balancer-arns", r.id],
  aws_lb_listener: (r) => ["elbv2", "describe-listeners", "--listener-arns", r.id],
  aws_lb_target_group: (r) => ["elbv2", "describe-target-groups", "--target-group-arns", r.id],
  aws_efs_file_system: (r) => ["efs", "describe-file-systems", "--file-system-id", r.id],
  aws_efs_access_point: (r) => ["efs", "describe-access-points", "--access-point-id", r.id],
  aws_efs_mount_target: (r) => ["efs", "describe-mount-targets", "--mount-target-id", r.id],
  aws_secretsmanager_secret: (r) => ["secretsmanager", "describe-secret", "--secret-id", r.id],
  aws_iam_role: (r) => ["iam", "get-role", "--role-name", r.id],
  aws_service_discovery_service: (r) => ["servicediscovery", "get-service", "--id", r.id],
  aws_service_discovery_private_dns_namespace: (r) => ["servicediscovery", "get-namespace", "--id", r.id],
  aws_cloudwatch_log_group: (r) => ["logs", "describe-log-groups", "--log-group-name-prefix", r.id],
  aws_ecr_repository: (r) => ["ecr", "describe-repositories", "--repository-names", r.id],
  s3_state_object: (r) => ["s3api", "head-object", "--bucket", r.parent, "--key", r.id],
};

function scopeValid(scope) {
  if (!own(scope) || !UUID.test(scope.projectId) || !UUID.test(scope.operationId)
    || !/^[a-z][a-z0-9_-]{0,63}$/.test(scope.environmentName)
    || !/^\d{12}$/.test(scope.accountId) || !/^[a-z]{2}(?:-[a-z]+)+-\d$/.test(scope.region)
    || !Array.isArray(scope.generationIds) || !scope.generationIds.length
    || scope.generationIds.some((id) => !UUID.test(id)) || new Set(scope.generationIds).size !== scope.generationIds.length
    || Object.keys(scope).some((key) => !["projectId", "operationId", "generationIds", "environmentName", "accountId", "region"].includes(key))) throw new Error("DG_DELETION_SCOPE_INVALID");
}

export function validateDeletionManifest(manifest) {
  scopeValid(manifest?.scope);
  if (manifest.contractVersion !== VERSION || !Array.isArray(manifest.resources) || !manifest.resources.length
    || manifest.resources.length > 1000) throw new Error("DG_DELETION_SCOPE_INVALID");
  const seen = new Set();
  for (const resource of manifest.resources) {
    if (!own(resource) || !Object.hasOwn(commands, resource.type) || !text(resource.id)
      || (resource.parent !== undefined && !text(resource.parent))
      || Object.keys(resource).some((key) => !["type", "id", "parent"].includes(key))) throw new Error("DG_DELETION_SCOPE_INVALID");
    const identity = `${resource.type}:${resource.parent || ""}:${resource.id}`;
    if (seen.has(identity)) throw new Error("DG_DELETION_SCOPE_INVALID");
    seen.add(identity);
    if (["aws_ecs_service", "s3_state_object"].includes(resource.type) && !resource.parent) throw new Error("DG_DELETION_SCOPE_INVALID");
    for (const identifier of [resource.id, resource.parent].filter(Boolean)) {
      if (identifier.startsWith("arn:")) {
        const parts = identifier.split(":");
        if (parts[1] !== "aws" || parts[4] !== manifest.scope.accountId || (parts[3] && parts[3] !== manifest.scope.region)) throw new Error("DG_DELETION_SCOPE_INVALID");
      }
    }
    if (resource.type === "s3_state_object" && !resource.id.startsWith(`projects/${manifest.scope.projectId}/${manifest.scope.environmentName}/`)) throw new Error("DG_DELETION_SCOPE_INVALID");
  }
  return manifest;
}

// Capture only identifiers, never passwords, container definitions, or ENV.
// Child resources without tags require a parent in this same owned state.
export function captureDeletionManifest(state, scope) {
  scopeValid(scope);
  const resources = [];
  const walk = (module) => {
    if (!own(module)) throw new Error("DG_DELETION_SCOPE_INVALID");
    resources.push(...(module.resources || []).filter((r) => r.mode === "managed"));
    for (const child of module.child_modules || []) walk(child);
  };
  walk(state?.values?.root_module);
  const tagged = resources.filter((r) => r.values?.tags?.ManagedBy === "DeployGuard" && r.values.tags.DeployGuardProjectId === scope.projectId);
  const owned = new Set(tagged
    .flatMap((r) => [r.values.id, r.values.arn]).filter(Boolean));
  const parentOwned = (type, id) => tagged.some((r) => r.type === type && [r.values.id, r.values.arn].includes(id));
  const result = [];
  for (const r of resources) {
    const v = r.values || {};
    const delegatedParent = {
      aws_iam_role_policy: ["aws_iam_role", v.role], aws_iam_role_policy_attachment: ["aws_iam_role", v.role],
      aws_secretsmanager_secret_version: ["aws_secretsmanager_secret", v.secret_id],
    }[r.type];
    if (r.type === "random_password") continue;
    if (delegatedParent && parentOwned(...delegatedParent)) continue; // Parent absence proves these children removed; AWS-managed IAM policy is shared.
    if (!Object.hasOwn(commands, r.type)) throw new Error("DG_DELETION_SCOPE_INVALID");
    const parent = { aws_lb_listener: v.load_balancer_arn, aws_efs_access_point: v.file_system_id, aws_efs_mount_target: v.file_system_id }[r.type];
    if (!owned.has(v.id) && !owned.has(v.arn) && !(parent && owned.has(parent))) throw new Error("DG_DELETION_SCOPE_INVALID");
    if (r.type === "aws_ecs_service" && !parentOwned("aws_ecs_cluster", v.cluster)) throw new Error("DG_DELETION_SCOPE_INVALID");
    const id = ["aws_lb", "aws_lb_listener", "aws_lb_target_group", "aws_ecs_task_definition", "aws_secretsmanager_secret"].includes(r.type) ? v.arn : r.type === "aws_cloudwatch_log_group" || r.type === "aws_iam_role" ? v.name : v.id;
    result.push({ type: r.type, id, ...(r.type === "aws_ecs_service" ? { parent: v.cluster } : {}) });
  }
  return validateDeletionManifest({ contractVersion: VERSION, scope: structuredClone(scope), resources: result });
}

function successfulObservation(r, payload) {
  if (!own(payload) || payload.NextToken || payload.nextToken) return "UNVERIFIED";
  if (r.type === "aws_cloudwatch_log_group") {
    if (!Array.isArray(payload.logGroups) || payload.logGroups.some((g) => !text(g.logGroupName))) return "UNVERIFIED";
    return payload.logGroups.some((g) => g.logGroupName === r.id) ? "CONFIRMED DEFECT" : "PASS";
  }
  if (["aws_ecs_cluster", "aws_ecs_service"].includes(r.type)) {
    const list = r.type === "aws_ecs_cluster" ? payload.clusters : payload.services;
    if (!Array.isArray(list) || !Array.isArray(payload.failures)) return "UNVERIFIED";
    const key = r.type === "aws_ecs_cluster" ? "clusterArn" : "serviceArn";
    if (list.length === 1 && list[0][key] === r.id && payload.failures.length === 0) {
      if (!["ACTIVE", "DRAINING", "INACTIVE"].includes(list[0].status)) return "UNVERIFIED";
      return list[0].status === "INACTIVE" && (r.type !== "aws_ecs_service" || (list[0].runningCount === 0 && list[0].pendingCount === 0)) ? "PASS" : "CONFIRMED DEFECT";
    }
    return list.length === 0 && payload.failures.length === 1 && payload.failures[0].arn === r.id && payload.failures[0].reason === "MISSING" ? "PASS" : "UNVERIFIED";
  }
  if (r.type === "aws_ecs_task_definition") {
    const definition = payload.taskDefinition;
    if (!own(definition) || definition.taskDefinitionArn !== r.id || !["ACTIVE", "INACTIVE", "DELETE_IN_PROGRESS"].includes(definition.status)) return "UNVERIFIED";
    // ECS retains inactive revision history. Deregistration, not physical
    // erasure of that AWS history, is the Terraform destroy contract.
    return definition.status === "INACTIVE" || definition.status === "DELETE_IN_PROGRESS" ? "PASS" : "CONFIRMED DEFECT";
  }
  const presence = {
    aws_security_group: payload.SecurityGroups?.some((g) => g.GroupId === r.id),
    aws_lb: payload.LoadBalancers?.some((g) => g.LoadBalancerArn === r.id),
    aws_lb_listener: payload.Listeners?.some((g) => g.ListenerArn === r.id),
    aws_lb_target_group: payload.TargetGroups?.some((g) => g.TargetGroupArn === r.id),
    aws_efs_file_system: payload.FileSystems?.some((g) => g.FileSystemId === r.id),
    aws_efs_access_point: payload.AccessPoints?.some((g) => g.AccessPointId === r.id),
    aws_efs_mount_target: payload.MountTargets?.some((g) => g.MountTargetId === r.id),
    aws_secretsmanager_secret: payload.ARN === r.id,
    aws_iam_role: payload.Role?.RoleName === r.id,
    aws_service_discovery_service: payload.Service?.Id === r.id,
    aws_service_discovery_private_dns_namespace: payload.Namespace?.Id === r.id,
    aws_ecr_repository: payload.repositories?.some((g) => g.repositoryName === r.id),
    s3_state_object: typeof payload.ContentLength === "number",
  }[r.type];
  // Empty success responses are not proof of absence for exact-ID APIs.
  return presence === true ? "CONFIRMED DEFECT" : "UNVERIFIED";
}

export async function observeDeletion(manifest, run, options = {}) {
  validateDeletionManifest(manifest); // Reject invalid scope before ANY AWS call.
  const attempts = options.attempts ?? 3;
  const delayMs = options.delayMs ?? 1000;
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 10 || !Number.isInteger(delayMs) || delayMs < 0 || delayMs > 5000) throw new Error("DG_DELETION_SCOPE_INVALID");
  const invoke = (args) => run([...args, "--region", manifest.scope.region, "--output", "json", "--no-cli-pager"]);
  const observations = [];
  try {
    const identity = await invoke(["sts", "get-caller-identity"]);
    if (identity.status !== 0 || JSON.parse(identity.stdout).Account !== manifest.scope.accountId) throw new Error();
  } catch {
    return { contractVersion: "deployguard.aws-deletion-observation/v1", scope: manifest.scope, status: "UNVERIFIED", code: "DG_DELETION_ACCOUNT_UNVERIFIED", observations };
  }
  const absentClusters = new Set();
  const orderedResources = [...manifest.resources].sort((a, b) => Number(b.type === "aws_ecs_cluster") - Number(a.type === "aws_ecs_cluster"));
  for (const resource of orderedResources) {
    let status = "UNVERIFIED";
    let providerCode = null;
    let observedAttempts = 0;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      observedAttempts = attempt;
      try {
        const result = await invoke(commands[resource.type](resource));
        if (result.status === 0) status = successfulObservation(resource, JSON.parse(result.stdout));
        else {
          // Match the structured AWS CLI error header, not arbitrary text that
          // might contain both AccessDenied and a misleading NotFound string.
          providerCode = String(result.stderr || "").match(/^An error occurred \(([A-Za-z0-9.]+)\) when calling the [A-Za-z0-9]+ operation:/m)?.[1] || null;
          status = providerCode && absentErrors[resource.type]?.includes(providerCode) ? "PASS" : "UNVERIFIED";
          // AWS cannot describe a service after its cluster has been removed.
          // Accept this only with independent absence proof for that exact
          // cluster in the same pass, never on the exception alone.
          if (resource.type === "aws_ecs_service" && providerCode === "ClusterNotFoundException" && absentClusters.has(resource.parent)) status = "PASS";
        }
      } catch { status = "UNVERIFIED"; }
      if (status !== "CONFIRMED DEFECT" || attempt === attempts) break;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    if (resource.type === "aws_ecs_cluster" && status === "PASS") absentClusters.add(resource.id);
    observations.push({ ...resource, status, providerCode, attempts: observedAttempts });
  }
  const status = observations.some((r) => r.status === "UNVERIFIED") ? "UNVERIFIED" : observations.every((r) => r.status === "PASS") ? "PASS" : "CONFIRMED DEFECT";
  return {
    contractVersion: "deployguard.aws-deletion-observation/v1", scope: manifest.scope,
    manifestSha256: createHash("sha256").update(JSON.stringify(manifest)).digest("hex"),
    status, code: status === "PASS" ? null : "DG_AWS_DELETION_NOT_VERIFIED",
    observations, verifiedAt: new Date().toISOString(),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // Explicit read-only invocation, separate from the destructive workflow.
  if (process.argv.length !== 4 || process.argv[2] !== "--manifest") throw new Error("Usage: node observe-deletion.mjs --manifest retained-manifest.json");
  const manifest = JSON.parse(readFileSync(process.argv[3], "utf8"));
  const exec = promisify(execFile);
  const run = async (args) => {
    try {
      const result = await exec("aws", args, { timeout: 30000, maxBuffer: 2 * 1024 * 1024, env: { ...process.env, AWS_PAGER: "", AWS_MAX_ATTEMPTS: "2" } });
      return { status: 0, stdout: result.stdout, stderr: result.stderr };
    } catch (error) { return { status: 1, stdout: "", stderr: error.stderr || "" }; }
  };
  const report = await observeDeletion(manifest, run);
  process.stdout.write(`${JSON.stringify(report)}\n`);
  if (report.status !== "PASS") process.exitCode = 1;
}
