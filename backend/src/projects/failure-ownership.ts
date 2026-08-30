export const FAILURE_OWNERS = ["REPOSITORY_APPLICATION", "DEPLOYGUARD_PLATFORM", "EXTERNAL_PROVIDER", "UNVERIFIED"] as const;
export type FailureOwner = typeof FAILURE_OWNERS[number];
export const EXTERNAL_PROVIDERS = ["aws", "github", "railpack", "network", "other"] as const;
export type ExternalProvider = typeof EXTERNAL_PROVIDERS[number];

export type StructuredFailure = { failureOwner: FailureOwner; externalProvider: ExternalProvider | null; failureCode: string; failureServiceId: string | null };

/** Classifies only explicit boundary evidence; ambiguity intentionally remains UNVERIFIED. */
export function classifyStructuredFailure(stage: string, safeEvidence: string): StructuredFailure {
  const marker = safeEvidence.match(/DG_FAILURE\s+([^\r\n]{1,500})/i)?.[1] || "";
  const serviceId = marker.match(/(?:^|\s)serviceId=([0-9a-f-]{36})(?:\s|$)/i)?.[1] || null;
  const code = marker.match(/(?:^|\s)code=(DG_[A-Z0-9_]+)(?:\s|$)/i)?.[1]
    || safeEvidence.match(/\b(DG_(?!FAILURE\b)[A-Z0-9_]+)\b/)?.[1]
    || "DG_FAILURE_UNVERIFIED";
  if (["DG_SERVICE_DIRECTORY_INVALID", "DG_WORKFLOW_CONTRACT_INVALID", "DG_TERRAFORM_MATERIALIZATION_FAILED", "DG_TERRAFORM_VALIDATE_FAILED"].includes(code)) return { failureOwner: "DEPLOYGUARD_PLATFORM", externalProvider: null, failureCode: code, failureServiceId: serviceId };
  if (["DG_SERVICE_DIRECTORY_MISSING", "DG_RAILPACK_BUILD_FAILED", "DG_APPLICATION_RUNTIME_FAILED"].includes(code)) return { failureOwner: "REPOSITORY_APPLICATION", externalProvider: null, failureCode: code, failureServiceId: serviceId };
  if (code === "DG_RAILPACK_PREREQUISITE_FAILED") return { failureOwner: "EXTERNAL_PROVIDER", externalProvider: "railpack", failureCode: code, failureServiceId: serviceId };
  if (["DG_ECR_PUBLISH_FAILED", "DG_AWS_AUTHORIZATION_FAILED", "DG_AWS_PROVIDER_FAILED", "DG_ECS_STABILITY_FAILED"].includes(code)) return { failureOwner: "EXTERNAL_PROVIDER", externalProvider: "aws", failureCode: code, failureServiceId: serviceId };
  if (stage === "github_authentication" || stage === "workflow_dispatch") return { failureOwner: "EXTERNAL_PROVIDER", externalProvider: "github", failureCode: "DG_GITHUB_PROVIDER_FAILED", failureServiceId: serviceId };
  return { failureOwner: "UNVERIFIED", externalProvider: null, failureCode: code, failureServiceId: serviceId };
}
