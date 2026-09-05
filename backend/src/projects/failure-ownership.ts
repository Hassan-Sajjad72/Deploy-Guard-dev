import { classifyEcsDiagnosticsOwnership, ecsDiagnosticsFromEvidence } from "./recovery/ecs-diagnostics-classifier.service";

export const FAILURE_OWNERS = ["REPOSITORY_APPLICATION", "DEPLOYGUARD_PLATFORM", "EXTERNAL_PROVIDER", "UNVERIFIED"] as const;
export type FailureOwner = typeof FAILURE_OWNERS[number];
export const EXTERNAL_PROVIDERS = ["aws", "github", "railpack", "network", "other"] as const;
export type ExternalProvider = typeof EXTERNAL_PROVIDERS[number];

export type StructuredFailure = { failureOwner: FailureOwner; externalProvider: ExternalProvider | null; failureCode: string; failureServiceId: string | null };

export function terminalStructuredFailureMarker(safeEvidence: string) {
  const markers = [...safeEvidence.matchAll(/DG_FAILURE\s+([^\r\n]{1,500})/gi)];
  const marker = markers.at(-1)?.[1] || "";
  return {
    code: marker.match(/(?:^|\s)code=(DG_[A-Z0-9_]+)(?:\s|$)/i)?.[1] || null,
    serviceId: marker.match(/(?:^|\s)serviceId=([0-9a-f-]{36})(?:\s|$)/i)?.[1] || null,
    stage: marker.match(/(?:^|\s)stage=([a-z0-9_]+)(?:\s|$)/i)?.[1] || null,
  };
}

/** Classifies only explicit boundary evidence; ambiguity intentionally remains UNVERIFIED. */
export function classifyStructuredFailure(stage: string, safeEvidence: string): StructuredFailure {
  // GitHub renders the complete shell script before executing it. A terminal
  // log can therefore contain source lines for failure markers that were
  // never emitted. Only an explicit machine-readable marker is authority;
  // when more than one is present, the final emitted marker is the terminal
  // boundary reached by the failed step.
  const marker = terminalStructuredFailureMarker(safeEvidence);
  const serviceId = marker.serviceId;
  const code = marker.code || "DG_FAILURE_UNVERIFIED";
  if (["DG_SERVICE_DIRECTORY_INVALID", "DG_WORKFLOW_CONTRACT_INVALID", "DG_CONTROL_PLANE_VERSION_MISMATCH", "DG_TERRAFORM_MATERIALIZATION_FAILED", "DG_TERRAFORM_VALIDATE_FAILED", "DG_TERRAFORM_PLAN_FAILED", "DG_MANAGED_DATABASE_READINESS_FAILED", "DG_MANAGED_MYSQL_GRANT_RECONCILIATION_FAILED", "DG_BUILD_TARGET_UNRESOLVED", "DG_BUILD_TARGET_AMBIGUOUS", "DG_BUILD_TARGET_UNSUPPORTED", "DG_BUILD_TARGET_INVALID", "DG_DEPLOYMENT_INPUT_REQUIRED", "DG_DEPLOYMENT_REQUIREMENTS_BLOCKED"].includes(code)) return { failureOwner: "DEPLOYGUARD_PLATFORM", externalProvider: null, failureCode: code, failureServiceId: serviceId };
  if (["DG_SERVICE_DIRECTORY_MISSING", "DG_SERVICE_PORT_UNRESOLVED", "DG_SERVICE_PORT_CONFLICT", "DG_SERVICE_PORT_INVALID", "DG_APPLICATION_RUNTIME_FAILED"].includes(code)) return { failureOwner: "REPOSITORY_APPLICATION", externalProvider: null, failureCode: code, failureServiceId: serviceId };
  if (code === "DG_LOCAL_HOST_PORT_ALLOCATION_FAILED") return { failureOwner: "DEPLOYGUARD_PLATFORM", externalProvider: null, failureCode: code, failureServiceId: serviceId };
  if (code === "DG_RAILPACK_PREREQUISITE_FAILED") return { failureOwner: "EXTERNAL_PROVIDER", externalProvider: "railpack", failureCode: code, failureServiceId: serviceId };
  if (code === "DG_ECS_STABILITY_FAILED") return { ...classifyEcsDiagnosticsOwnership(ecsDiagnosticsFromEvidence(safeEvidence)), failureCode: code, failureServiceId: serviceId };
  if (code === "DG_AWS_RUNTIME_CONFIGURATION_FAILED") return { failureOwner: "DEPLOYGUARD_PLATFORM", externalProvider: null, failureCode: code, failureServiceId: serviceId };
  if (["DG_TERRAFORM_APPLY_FAILED", "DG_ECR_PUBLISH_FAILED", "DG_AWS_AUTHORIZATION_FAILED", "DG_AWS_PROVIDER_FAILED"].includes(code)) return { failureOwner: "EXTERNAL_PROVIDER", externalProvider: "aws", failureCode: code, failureServiceId: serviceId };
  if (stage === "github_authentication" || stage === "workflow_dispatch") return { failureOwner: "EXTERNAL_PROVIDER", externalProvider: "github", failureCode: "DG_GITHUB_PROVIDER_FAILED", failureServiceId: serviceId };
  return { failureOwner: "UNVERIFIED", externalProvider: null, failureCode: code, failureServiceId: serviceId };
}
