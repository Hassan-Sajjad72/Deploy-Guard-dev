export type ExistingProjectStateClassification =
  | "valid"
  | "adoptable"
  | "recoverable"
  | "safe_residue"
  | "ambiguous";

export type ExistingProjectStateOperatorAction =
  | "none"
  | "review_adoption"
  | "resume_immutable_operation"
  | "clean_verified_residue"
  | "review_evidence";

export type ExistingProjectStateEvidence = {
  releaseLaneState: string;
  releaseLaneHasImmutableIntent: boolean;
  releaseLaneConflict: boolean;
  canonicalStableReleasePresent: boolean;
  legacyStableReleasePresent: boolean;
  deploymentRecordPresent: boolean;
  infrastructureRecordPresent: boolean;
  cloudVerificationStatus: string;
  deploymentStatus: string;
  healthStatus: string;
  infrastructureStatus: string;
  resourceStatus: string;
  cleanupStatus: string;
  terraformStateStatus: string;
  terraformValidationStatus: string;
  terraformRecoveryRequired: boolean;
  terraformRecoveryActive: boolean;
  activeExecutionEvidence: boolean;
  projectCleanupRecommended: boolean;
  verifiedResidueCount: number;
  unknownResourceCount: number;
  resourceOwnershipCategories: readonly string[];
};

export type ExistingProjectStateDecision = {
  classification: ExistingProjectStateClassification;
  safeCode: string;
  summary: string;
  operatorAction: ExistingProjectStateOperatorAction;
  cleanupAllowed: boolean;
  evidence: {
    cloudEvidenceFresh: boolean;
    stableReleaseVerified: boolean;
    terraformEvidenceConsistent: boolean;
    immutableOperationActive: boolean;
    executionScopeClear: boolean;
    exactResidueVerified: boolean;
    unknownResourceCount: number;
  };
};

const ACTIVE_RELEASE_STATES = new Set(["prepared", "queued", "running", "reconciling"]);
const HEALTHY_STATE_STATUSES = new Set(["active", "recovered", "missing"]);
const HEALTHY_VALIDATIONS = new Set(["valid", "not_validated"]);
const RESIDUE_CATEGORIES = new Set(["verified_residue", "shared_platform"]);
const PROJECT_RESOURCE_EVIDENCE = new Set([
  "active_resources",
  "cleanup_required",
  "manual_review_required",
  "protected_only",
]);

/**
 * Fail-closed, side-effect-free classification for operator reconciliation.
 * A clean project deliberately returns null: the five classifications apply
 * only when durable infrastructure, deployment, release, or operation
 * evidence already exists.
 */
export function classifyExistingProjectState(
  input: ExistingProjectStateEvidence,
): ExistingProjectStateDecision | null {
  const releaseActive = ACTIVE_RELEASE_STATES.has(input.releaseLaneState)
    && input.releaseLaneHasImmutableIntent;
  const cloudEvidenceFresh = input.cloudVerificationStatus === "verified";
  const terraformEvidenceConsistent = !input.terraformRecoveryRequired
    && HEALTHY_STATE_STATUSES.has(input.terraformStateStatus)
    && HEALTHY_VALIDATIONS.has(input.terraformValidationStatus);
  const executionScopeClear = !input.activeExecutionEvidence;
  const stableReleaseVerified = input.canonicalStableReleasePresent
    && cloudEvidenceFresh
    && input.deploymentStatus === "live"
    && input.healthStatus === "healthy"
    && input.infrastructureStatus === "provisioned"
    && terraformEvidenceConsistent;
  const exactResidueVerified = cloudEvidenceFresh
    && input.projectCleanupRecommended
    && input.cleanupStatus === "cleanup_required"
    && input.verifiedResidueCount > 0
    && input.unknownResourceCount === 0
    && input.resourceOwnershipCategories.length > 0
    && input.resourceOwnershipCategories.every((category) => RESIDUE_CATEGORIES.has(category));
  const existingEvidence = input.canonicalStableReleasePresent
    || input.legacyStableReleasePresent
    || input.deploymentRecordPresent
    || input.infrastructureRecordPresent
    || input.terraformStateStatus !== "missing"
    // Inventory transport/read failures are not evidence that this project
    // owns provider resources. Positive project-scoped resource evidence is.
    || PROJECT_RESOURCE_EVIDENCE.has(input.resourceStatus)
    || input.verifiedResidueCount > 0
    || input.unknownResourceCount > 0
    || releaseActive
    || input.terraformRecoveryActive;

  if (!existingEvidence) return null;

  const evidence = {
    cloudEvidenceFresh,
    stableReleaseVerified,
    terraformEvidenceConsistent,
    immutableOperationActive: releaseActive,
    executionScopeClear,
    exactResidueVerified,
    unknownResourceCount: input.unknownResourceCount,
  };

  if (input.releaseLaneConflict) {
    return decision(
      "ambiguous",
      "EXISTING_STATE_IDENTITY_CONFLICT",
      "Existing deployment identities conflict and require operator review.",
      "review_evidence",
      false,
      evidence,
    );
  }

  if (releaseActive && !input.terraformRecoveryRequired) {
    return decision(
      "recoverable",
      "EXISTING_STATE_IMMUTABLE_OPERATION_RECOVERABLE",
      "The same immutable normal-v1 operation can continue through bounded reconciliation.",
      "resume_immutable_operation",
      false,
      evidence,
    );
  }

  if (stableReleaseVerified && executionScopeClear) {
    return decision(
      "valid",
      "EXISTING_STATE_STABLE_DEPLOYMENT_VERIFIED",
      "The canonical stable deployment and its cloud runtime are verified.",
      "none",
      false,
      evidence,
    );
  }

  if (
    !input.canonicalStableReleasePresent
    && input.deploymentRecordPresent
    && cloudEvidenceFresh
    && input.deploymentStatus === "live"
    && input.healthStatus === "healthy"
    && input.infrastructureStatus === "provisioned"
    && terraformEvidenceConsistent
    && executionScopeClear
  ) {
    return decision(
      "adoptable",
      "EXISTING_STATE_DEPLOYMENT_ADOPTABLE",
      "Matching healthy project infrastructure exists without a canonical stable projection.",
      "review_adoption",
      false,
      evidence,
    );
  }

  if (
    exactResidueVerified
    && executionScopeClear
    && !input.canonicalStableReleasePresent
    && input.deploymentStatus !== "live"
  ) {
    return decision(
      "safe_residue",
      "EXISTING_STATE_SAFE_RESIDUE_VERIFIED",
      "A completed destroy left only conclusively identified project residue.",
      "clean_verified_residue",
      true,
      evidence,
    );
  }

  return decision(
    "ambiguous",
    "EXISTING_STATE_OPERATOR_REVIEW_REQUIRED",
    "Existing project evidence is incomplete, stale, or contradictory.",
    "review_evidence",
    false,
    evidence,
  );
}

function decision(
  classification: ExistingProjectStateClassification,
  safeCode: string,
  summary: string,
  operatorAction: ExistingProjectStateOperatorAction,
  cleanupAllowed: boolean,
  evidence: ExistingProjectStateDecision["evidence"],
): ExistingProjectStateDecision {
  return Object.freeze({
    classification,
    safeCode,
    summary,
    operatorAction,
    cleanupAllowed,
    evidence: Object.freeze({ ...evidence }),
  });
}
