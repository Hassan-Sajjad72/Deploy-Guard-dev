import { classifyEcsDiagnosticsOwnership, ecsDiagnosticsFromEvidence } from "./recovery/ecs-diagnostics-classifier.service";
import { EXTERNAL_PROVIDERS, ExternalProvider, FAILURE_OWNERS, failureContractFor, FailureOwner } from "./failure-diagnostics/failure-contract.catalog";

export { EXTERNAL_PROVIDERS, ExternalProvider, FAILURE_OWNERS, FailureOwner };

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
  return classifyFailureCode(code, marker.stage || stage, safeEvidence, serviceId);
}

/** Resolves a persisted authoritative terminal code without mutating its audit snapshot. */
export function classifyFailureCode(code: string, stage: string, safeEvidence: string, serviceId: string | null = null): StructuredFailure {
  if (code === "DG_ECS_STABILITY_FAILED") return { ...classifyEcsDiagnosticsOwnership(ecsDiagnosticsFromEvidence(safeEvidence)), failureCode: code, failureServiceId: serviceId };
  const contract = failureContractFor(code);
  if (contract) return { failureOwner: contract.owner, externalProvider: contract.provider, failureCode: code, failureServiceId: serviceId };
  if (stage === "github_authentication" || stage === "workflow_dispatch") return { failureOwner: "EXTERNAL_PROVIDER", externalProvider: "github", failureCode: "DG_GITHUB_PROVIDER_FAILED", failureServiceId: serviceId };
  return { failureOwner: "UNVERIFIED", externalProvider: null, failureCode: code, failureServiceId: serviceId };
}
