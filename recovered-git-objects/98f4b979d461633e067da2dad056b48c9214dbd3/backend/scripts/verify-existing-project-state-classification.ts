import { strict as assert } from "node:assert";
import {
  classifyExistingProjectState,
  ExistingProjectStateEvidence,
} from "../src/projects/current-state/existing-project-state-classifier";

const clean: ExistingProjectStateEvidence = {
  releaseLaneState: "missing",
  releaseLaneHasImmutableIntent: false,
  releaseLaneConflict: false,
  canonicalStableReleasePresent: false,
  legacyStableReleasePresent: false,
  deploymentRecordPresent: false,
  infrastructureRecordPresent: false,
  cloudVerificationStatus: "verified",
  deploymentStatus: "not_deployed",
  healthStatus: "not_applicable",
  infrastructureStatus: "not_provisioned",
  resourceStatus: "no_cloud_resources_found",
  cleanupStatus: "not_requested",
  terraformStateStatus: "missing",
  terraformValidationStatus: "not_validated",
  terraformRecoveryRequired: false,
  terraformRecoveryActive: false,
  activeExecutionEvidence: false,
  projectCleanupRecommended: false,
  verifiedResidueCount: 0,
  unknownResourceCount: 0,
  resourceOwnershipCategories: [],
};

const classify = (overrides: Partial<ExistingProjectStateEvidence>) =>
  classifyExistingProjectState({ ...clean, ...overrides });

assert.equal(classify({}), null, "a clean project must not be treated as existing state");
assert.equal(classify({
  cloudVerificationStatus: "verification_failed",
  resourceStatus: "inventory_error",
}), null, "an inventory read failure alone is not project resource evidence");
assert.equal(classify({
  cloudVerificationStatus: "verification_failed",
  resourceStatus: "inventory_unavailable",
}), null, "an unavailable inventory alone is not project resource evidence");

const valid = classify({
  releaseLaneState: "completed",
  releaseLaneHasImmutableIntent: true,
  canonicalStableReleasePresent: true,
  deploymentRecordPresent: true,
  infrastructureRecordPresent: true,
  deploymentStatus: "live",
  healthStatus: "healthy",
  infrastructureStatus: "provisioned",
  terraformStateStatus: "active",
  terraformValidationStatus: "valid",
});
assert.equal(valid?.classification, "valid");
assert.equal(valid?.operatorAction, "none");
assert.equal(valid?.cleanupAllowed, false);

const adoptable = classify({
  legacyStableReleasePresent: true,
  deploymentRecordPresent: true,
  infrastructureRecordPresent: true,
  deploymentStatus: "live",
  healthStatus: "healthy",
  infrastructureStatus: "provisioned",
  terraformStateStatus: "active",
  terraformValidationStatus: "valid",
});
assert.equal(adoptable?.classification, "adoptable");
assert.equal(adoptable?.operatorAction, "review_adoption");
assert.equal(adoptable?.cleanupAllowed, false);

const protectedResources = classify({
  resourceStatus: "protected_only",
});
assert.equal(protectedResources?.classification, "ambiguous");
assert.equal(protectedResources?.operatorAction, "review_evidence");

const recoverable = classify({
  releaseLaneState: "reconciling",
  releaseLaneHasImmutableIntent: true,
  infrastructureRecordPresent: true,
  activeExecutionEvidence: true,
  terraformStateStatus: "active",
  terraformValidationStatus: "valid",
});
assert.equal(recoverable?.classification, "recoverable");
assert.equal(recoverable?.operatorAction, "resume_immutable_operation");

const residue = classify({
  deploymentRecordPresent: true,
  infrastructureRecordPresent: true,
  deploymentStatus: "destroyed",
  infrastructureStatus: "destroy_completed",
  resourceStatus: "cleanup_required",
  cleanupStatus: "cleanup_required",
  projectCleanupRecommended: true,
  verifiedResidueCount: 2,
  resourceOwnershipCategories: ["verified_residue", "shared_platform"],
});
assert.equal(residue?.classification, "safe_residue");
assert.equal(residue?.operatorAction, "clean_verified_residue");
assert.equal(residue?.cleanupAllowed, true);

for (const unsafe of [
  classify({
    deploymentRecordPresent: true,
    cloudVerificationStatus: "stale",
    resourceStatus: "inventory_required",
  }),
  classify({
    releaseLaneState: "completed",
    releaseLaneHasImmutableIntent: true,
    releaseLaneConflict: true,
    canonicalStableReleasePresent: true,
  }),
  classify({
    deploymentRecordPresent: true,
    resourceStatus: "manual_review_required",
    unknownResourceCount: 1,
    resourceOwnershipCategories: ["unknown"],
  }),
  classify({
    deploymentRecordPresent: true,
    infrastructureRecordPresent: true,
    deploymentStatus: "destroyed",
    infrastructureStatus: "destroy_completed",
    resourceStatus: "cleanup_required",
    cleanupStatus: "cleanup_required",
    projectCleanupRecommended: true,
    verifiedResidueCount: 1,
    resourceOwnershipCategories: ["verified_residue"],
    activeExecutionEvidence: true,
  }),
  classify({
    releaseLaneState: "completed",
    canonicalStableReleasePresent: true,
    deploymentRecordPresent: true,
    infrastructureRecordPresent: true,
    deploymentStatus: "live",
    healthStatus: "healthy",
    infrastructureStatus: "provisioned",
    terraformStateStatus: "recovery_required",
    terraformValidationStatus: "failed",
    terraformRecoveryRequired: true,
  }),
]) {
  assert.equal(unsafe?.classification, "ambiguous");
  assert.equal(unsafe?.operatorAction, "review_evidence");
  assert.equal(unsafe?.cleanupAllowed, false);
}

console.log("Existing-project adoption and residue classification verification passed.");
