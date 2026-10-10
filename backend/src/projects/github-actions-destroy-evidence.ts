import { isCanonicalEnvironmentName } from "./canonical-environment";
import type { ProjectPipelineRun } from "./project-pipeline-run.entity";
import { assertRailpackRuntimeConfiguration, RailpackRuntimeConfiguration } from "./railpack-workflow-contract";
import { assertDestroyOwnership, OwnedAwsResource, ownershipSha256 } from "./aws-resource-ownership";
import { createHash } from "crypto";

export type GithubActionsDestroyEvidence = {
  contractVersion: "deployguard.destroy-result/v3";
  deploymentOperationId: string;
  projectId: string;
  environmentName: string;
  generationIds: string[];
  status: "project_delete_ready";
  generationResourcesRemoved: true;
  projectResourcesRemoved: true;
  terraformStateArtifactsRemoved: true;
  sharedPlatformUntouched: true;
  verifiedAt: string;
  ownershipSha256: string;
  observation: { contractVersion: "deployguard.aws-deletion-observation/v1"; scope: Record<string, unknown>; manifestSha256: string; status: "PASS"; code: null; verifiedAt: string; observations: Array<OwnedAwsResource & { status: "PASS"; basis: "absent" | "inactive" | "stopped"; providerCode: string | null; attempts: number }> };
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Raw persisted proof cannot manufacture eligibility or revoke a failed validation. */
export function hasValidatedDestroyCleanupStatus(operation: Pick<ProjectPipelineRun, "status" | "currentStage" | "metadata">): boolean {
  return operation.metadata?.deploymentAction === "destroy" && operation.metadata?.destroyEvidenceValidated === true
    && operation.currentStage === "project_delete_cleanup"
    && (operation.status === "completed" || (operation.status === "failed" && operation.metadata?.failureCategory === "project_delete_incomplete"));
}

/**
 * v2 flags remain readable in historical metadata, but cannot authorize cleanup.
 * v3 is accepted only with independent, exact-resource observations bound to
 * the complete ownership receipts frozen by server-side admission.
 */
export function extractGithubActionsDestroyEvidence(log: string): GithubActionsDestroyEvidence | null {
  const lines = log.split(/\r?\n/).filter((line) => line.includes("DEPLOYGUARD_DESTROY_RESULT="));
  for (const line of lines.reverse()) {
    const marker = line.indexOf("DEPLOYGUARD_DESTROY_RESULT=");
    try {
      const value = JSON.parse(line.slice(marker + "DEPLOYGUARD_DESTROY_RESULT=".length).trim()) as Record<string, unknown>;
      const evidence = githubActionsDestroyEvidenceFromValue(value);
      if (evidence) return evidence;
    } catch {
      // Malformed and unrelated output cannot advance deletion authority.
    }
  }
  return null;
}

/** Validate an artifact payload before it can erase project runtime authority. */
export function githubActionsDestroyEvidenceFromValue(value: unknown): GithubActionsDestroyEvidence | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  const generationIds = Array.isArray(candidate.generationIds)
    ? candidate.generationIds
    : [];
  if (
    candidate.contractVersion !== "deployguard.destroy-result/v3"
    || typeof candidate.deploymentOperationId !== "string"
    || !UUID.test(candidate.deploymentOperationId)
    || typeof candidate.projectId !== "string"
    || !UUID.test(candidate.projectId)
    || typeof candidate.environmentName !== "string"
    || !isCanonicalEnvironmentName(candidate.environmentName)
    || !generationIds.length
    || generationIds.some((id) => typeof id !== "string" || !UUID.test(id))
    || new Set(generationIds).size !== generationIds.length
    || candidate.status !== "project_delete_ready"
    || candidate.generationResourcesRemoved !== true
    || candidate.projectResourcesRemoved !== true
    || candidate.terraformStateArtifactsRemoved !== true
    || candidate.sharedPlatformUntouched !== true
    || typeof candidate.verifiedAt !== "string"
    || Number.isNaN(Date.parse(candidate.verifiedAt))
    || new Date(candidate.verifiedAt).toISOString() !== candidate.verifiedAt
    || typeof candidate.ownershipSha256 !== "string" || !/^[a-f0-9]{64}$/.test(candidate.ownershipSha256)
  ) return null;
  const observation = candidate.observation as GithubActionsDestroyEvidence["observation"];
  if (!observation || typeof observation !== "object" || Array.isArray(observation)
    || observation.contractVersion !== "deployguard.aws-deletion-observation/v1" || observation.status !== "PASS" || observation.code !== null
    || typeof observation.manifestSha256 !== "string" || !/^[a-f0-9]{64}$/.test(observation.manifestSha256)
    || observation.verifiedAt !== candidate.verifiedAt
    || !Array.isArray(observation.observations) || !observation.observations.length || observation.observations.length > 1000) return null;
  return {
    contractVersion: "deployguard.destroy-result/v3",
    deploymentOperationId: candidate.deploymentOperationId,
    projectId: candidate.projectId,
    environmentName: candidate.environmentName,
    generationIds: [...generationIds].sort(),
    status: "project_delete_ready",
    generationResourcesRemoved: true,
    projectResourcesRemoved: true,
    terraformStateArtifactsRemoved: true,
    sharedPlatformUntouched: true,
    verifiedAt: candidate.verifiedAt,
    ownershipSha256: candidate.ownershipSha256,
    observation: structuredClone(observation),
  };
}

/** A provider-success conclusion or mutable metadata marker is never proof. */
export function githubActionsDestroyEvidenceMatchesOperation(
  evidence: GithubActionsDestroyEvidence,
  operation: Pick<ProjectPipelineRun, "id" | "projectId" | "generationId" | "commitSha" | "metadata" | "startedAt">,
  environmentName: string,
): boolean {
  if (evidence.deploymentOperationId !== operation.id || evidence.projectId !== operation.projectId
    || evidence.environmentName !== environmentName || !operation.generationId
    || !(operation.startedAt instanceof Date) || !Number.isFinite(operation.startedAt.getTime())
    || Date.parse(evidence.verifiedAt) < operation.startedAt.getTime()) return false;
  const encoded = (operation.metadata?.immutableDispatchInputs as Record<string, unknown> | undefined)?.services_base64;
  if (typeof encoded !== "string") return false;
  try {
    const runtime = JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as RailpackRuntimeConfiguration;
    assertRailpackRuntimeConfiguration(runtime);
    if (runtime.projectId !== operation.projectId || runtime.operationId !== operation.id
      || runtime.sourceSha !== operation.commitSha || runtime.environmentName !== environmentName) return false;
    const expected = runtime.projectDeletion?.generationIds;
    const ownership = runtime.projectDeletion?.ownership;
    assertDestroyOwnership(ownership);
    const inputs = operation.metadata?.immutableDispatchInputs as Record<string, unknown>;
    const manifest = ownership.manifest;
    if (evidence.ownershipSha256 !== ownershipSha256(ownership)
      || evidence.observation.manifestSha256 !== createHash("sha256").update(JSON.stringify(manifest)).digest("hex")
      || ownershipSha256(evidence.observation.scope) !== ownershipSha256(manifest.scope)
      || inputs.aws_region !== manifest.scope.region
      || typeof inputs.aws_role_arn !== "string" || !inputs.aws_role_arn.startsWith(`arn:aws:iam::${manifest.scope.accountId}:role/`)
      || manifest.resources.some((r) => r.type === "s3_state_object" && r.parent !== inputs.terraform_state_bucket)) return false;
    const observations = evidence.observation.observations;
    if (observations.length !== manifest.resources.length) return false;
    const seen = new Set<string>();
    const absentCodes: Record<string, string[]> = {
      aws_security_group: ["InvalidGroup.NotFound"], aws_lb: ["LoadBalancerNotFound"], aws_lb_listener: ["ListenerNotFound"], aws_lb_target_group: ["TargetGroupNotFound"],
      aws_efs_file_system: ["FileSystemNotFound"], aws_efs_access_point: ["AccessPointNotFound"], aws_efs_mount_target: ["MountTargetNotFound"],
      aws_secretsmanager_secret: ["ResourceNotFoundException"], aws_iam_role: ["NoSuchEntity"], aws_service_discovery_service: ["ServiceNotFound"], aws_service_discovery_private_dns_namespace: ["NamespaceNotFound"],
      aws_ecr_repository: ["RepositoryNotFoundException"], s3_state_object: ["404", "NotFound", "NoSuchKey"],
    };
    for (const observation of observations) {
      if (!observation || typeof observation !== "object" || Array.isArray(observation)
        || Object.keys(observation).some((key) => !["type", "id", "parent", "status", "basis", "providerCode", "attempts"].includes(key))
        || observation.status !== "PASS" || !Number.isInteger(observation.attempts) || observation.attempts < 1 || observation.attempts > 10) return false;
      const key = JSON.stringify([observation.type, observation.id, observation.parent]);
      if (seen.has(key) || !manifest.resources.some((resource) => resource.type === observation.type && resource.id === observation.id && resource.parent === observation.parent)) return false;
      seen.add(key);
      const allowed = observation.type === "aws_ecs_task" ? ["absent", "stopped"]
        : observation.type === "aws_ecs_task_definition" ? ["inactive"]
          : ["aws_ecs_cluster", "aws_ecs_service"].includes(observation.type) ? ["absent", "inactive"] : ["absent"];
      if (!allowed.includes(observation.basis)) return false;
      if (observation.providerCode === null && !["aws_ecs_cluster", "aws_ecs_service", "aws_ecs_task", "aws_ecs_task_definition", "aws_cloudwatch_log_group"].includes(observation.type)) return false;
      if (observation.providerCode !== null) {
        const clusterAbsent = ["aws_ecs_service", "aws_ecs_task"].includes(observation.type) && observation.providerCode === "ClusterNotFoundException"
          && observations.some((r) => r.type === "aws_ecs_cluster" && r.id === observation.parent && r.status === "PASS" && r.basis === "absent" && r.providerCode === null);
        if (observation.basis !== "absent" || !(absentCodes[observation.type]?.includes(observation.providerCode) || clusterAbsent)) return false;
      }
    }
    return Array.isArray(expected) && expected.includes(operation.generationId)
      && expected.length === evidence.generationIds.length
      && [...expected].sort().every((id, index) => id === evidence.generationIds[index]);
  } catch { return false; }
}
