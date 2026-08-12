import { strict as assert } from "assert";
import { readFileSync } from "fs";
import { resolve } from "path";
import { extractGithubActionsDestroyEvidence, extractGithubActionsDestroyProgress } from "../src/projects/github-actions-destroy-evidence";

const operationId = "9ffe6827-f55a-4469-ac80-64530f8cea2e";
const evidence = {
  deploymentOperationId: operationId,
  status: "verified_destroyed",
  ecsServicesAbsent: true,
  runningTasksZero: true,
  loadBalancersAbsent: true,
  listenersAbsent: true,
  targetGroupsAbsent: true,
  endpointUnavailable: true,
  imageRepositoryAbsent: true,
  runtimeSecretAbsent: true,
  activeGenerationTaskDefinitionsAbsent: true,
  normalResourcesAbsent: true,
  terraformStateVersionsAbsent: true,
  projectOwnedAwsResourcesAbsent: true,
  allProjectTerraformArtifactsAbsent: true,
  retainedResourcesVerified: true,
  retainedTerraformAddresses: [],
  verifiedAt: "2026-08-10T12:00:00.000Z",
};

assert.deepEqual(extractGithubActionsDestroyEvidence(`DEPLOYGUARD_DESTROY_RESULT=${JSON.stringify(evidence)}`), evidence);
assert.equal(extractGithubActionsDestroyEvidence(`DEPLOYGUARD_DESTROY_RESULT=${JSON.stringify({ ...evidence, normalResourcesAbsent: false })}`), null);
for (const requiredAbsence of ["imageRepositoryAbsent", "runtimeSecretAbsent", "activeGenerationTaskDefinitionsAbsent", "terraformStateVersionsAbsent", "projectOwnedAwsResourcesAbsent", "allProjectTerraformArtifactsAbsent"] as const) {
  const incomplete: Record<string, unknown> = { ...evidence };
  delete incomplete[requiredAbsence];
  assert.equal(extractGithubActionsDestroyEvidence(`DEPLOYGUARD_DESTROY_RESULT=${JSON.stringify(incomplete)}`), null, `${requiredAbsence} is required before retirement`);
}
assert.equal(extractGithubActionsDestroyEvidence(`DEPLOYGUARD_DESTROY_RESULT=${JSON.stringify({ ...evidence, retainedTerraformAddresses: ["aws_efs_file_system.database[0]"] })}`), null, "a completed generation destroy retains no Terraform resource");
const incompleteEvidence = { deploymentOperationId: operationId, status: "DESTROY_INCOMPLETE", phase: "DESTROY_VERIFYING", remaining: [{ resourceType: "aws_resource", resourceId: "arn:aws:ecs:us-east-1:123456789012:service/cluster/service", ownershipScope: "generation", reason: "dependency", errorCode: "DependencyViolation", errorMessage: "pending", retryable: true, attemptCount: 1, firstSeenAt: "2026-08-10T12:00:00.000Z", lastSeenAt: "2026-08-10T12:00:00.000Z" }], terraform: { status: "apply_failed", importAttempted: false }, verifiedAt: "2026-08-10T12:00:00.000Z" };
assert.deepEqual(extractGithubActionsDestroyProgress(`DEPLOYGUARD_DESTROY_PROGRESS=${JSON.stringify(incompleteEvidence)}`), incompleteEvidence);

const workflow = readFileSync(resolve(__dirname, "../../.github/workflows/deployguard-reusable.yml"), "utf8");
const service = readFileSync(resolve(__dirname, "../src/projects/github-actions-deployment.service.ts"), "utf8");
assert.match(workflow, /terraform plan -destroy/);
assert.match(workflow, /A verified destroy removes the complete generation/);
assert.doesNotMatch(workflow, /terraform state rm "\$address"/, "destroy must never orphan persistence by removing it from state");
assert.doesNotMatch(workflow, /normal_state_resources_absent/, "stale state addresses are artifacts to purge after exact AWS absence, not proof of live infrastructure");
assert.match(workflow, /project_owned_resources_absent; then[\s\S]*?purge_project_state_versions[\s\S]*?project_state_versions_absent/, "exact AWS absence precedes exact state-version extinction");
assert.match(workflow, /delete_runtime_secret_if_owned/);
assert.match(workflow, /describe-secret --secret-id "\$RUNTIME_SECRET"/);
assert.match(workflow, /delete-secret --secret-id "\$RUNTIME_SECRET" --force-delete-without-recovery/);
assert.match(workflow, /runtime_secret_owned/);
assert.match(workflow, /\$tags\.DeployGuardGenerationId == \$generation/);
assert.match(workflow, /delete_generation_image_repository/);
assert.doesNotMatch(
  workflow.match(/delete_generation_image_repository\(\)[\s\S]*?^            \}/m)?.[0] || "",
  /tag-resource/,
  "Destroy must not convert an unscoped or historical ECR repository into current-generation ownership",
);
assert.match(workflow, /DeployGuardGenerationId == \$generation/);
assert.match(workflow, /refused to remove an unscoped or differently owned image repository/);
assert.doesNotMatch(workflow.match(/- name: Run generation-scoped AWS scavenger[\s\S]*?- name: Verify ALB health/)?.[0] || "", /RepositoryNotFoundException'[\s\S]{0,100}exit 0/, "already-absent ECR must not bypass remaining cleanup");
assert.match(workflow, /runtime_secret_absent/);
assert.match(workflow, /project_task_definitions_absent/);
assert.match(workflow, /project_task_definitions_absent\(\)[\s\S]*\[ "\$status" = "DELETE_IN_PROGRESS" \] \|\| return 1/);
assert.match(workflow, /project_owned_resources_absent\(\)[\s\S]*exact terminal[\s\S]*\.status == "INACTIVE"[\s\S]*select\(\.status == "ACTIVE"\)[\s\S]*DELETE_IN_PROGRESS[\s\S]*\*\) return 1/);
assert.match(workflow, /RESOURCE_NAME="dg-\$PROJECT_PREFIX-\$GENERATION_PREFIX"/);
assert.ok((workflow.match(/for family in "\$RESOURCE_NAME" "\$RESOURCE_NAME-database"/g) || []).length >= 2, "cleanup and absence verification use the same canonical task families");
assert.doesNotMatch(workflow, /for family in "dg-\$\(printf[\s\S]{0,180}cut -c1-28/, "Destroy never derives a divergent task family");
assert.match(workflow, /imageRepositoryAbsent:true/);
assert.match(workflow, /runtimeSecretAbsent:true/);
assert.match(workflow, /activeGenerationTaskDefinitionsAbsent:true/);
assert.match(workflow, /terraformStateVersionsAbsent:true/);
assert.match(workflow, /projectOwnedAwsResourcesAbsent:true/);
assert.match(workflow, /allProjectTerraformArtifactsAbsent:true/);
assert.match(workflow, /purge_tagged_project_resources/);
assert.match(workflow, /purge_project_state_versions/);
assert.match(workflow, /list-object-versions/);
assert.match(workflow, /delete-objects/);
assert.match(workflow, /retainedTerraformAddresses:\[\]/);
assert.match(workflow, /\$action == "destroy" and \(deletes \| not\)/, "destroy plans contain deletion actions only");
assert.doesNotMatch(service, /retireAfterVerifiedDestroy\(operation\.generationId, operation\.id\)/);
assert.match(service, /extinction\.extinguish\(project, saved, credential\.token,/);
assert.match(service, /destroyEvidenceMissing/);
assert.match(service, /destroy_absence_verification/);
assert.match(service, /destroyVerification: destroyEvidence/);

console.log("Verified destroy workflow passed: complete project extinction is required before success.");
