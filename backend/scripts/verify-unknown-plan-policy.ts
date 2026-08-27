import { strict as assert } from "node:assert";
import { DeploymentContractValidationService } from "../src/infrastructure/deployment-contract-validation.service";

const validator = new DeploymentContractValidationService();
const inputFingerprint = "terraform-input-fingerprint";
const canonical: any = {
  contractFingerprint: "contract-fingerprint",
  runtimeEntries: [
    { key: "APP_MODE", destination: "ecs_environment", sensitivity: "non_secret", owner: "user_required" },
    { key: "DB_PASSWORD", destination: "ecs_secret", sensitivity: "secret", owner: "managed_service" },
  ],
};
const variables = {
  ecs_environment_variables: { APP_MODE: "production" },
  ecs_secret_environment_variables: {},
  database_secret_alias_types: { DB_PASSWORD: "password" },
};
const draft = validator.taskDefinitionDraft(variables, canonical.contractFingerprint, inputFingerprint);

function plan(containerDefinitions: unknown, unknown = false, includeValue = true) {
  const values: Record<string, unknown> = {};
  if (includeValue) values.container_definitions = containerDefinitions;
  return JSON.stringify({
    planned_values: {
      root_module: {
        resources: [{ type: "aws_ecs_task_definition", name: "app", values }],
      },
    },
    resource_changes: [{
      type: "aws_ecs_task_definition",
      name: "app",
      change: { after_unknown: { container_definitions: unknown } },
    }],
  });
}

const known = plan(JSON.stringify([{
  name: "app",
  environment: [{ name: "APP_MODE", value: "production" }],
  secrets: [{ name: "DB_PASSWORD", valueFrom: "managed-reference" }],
}]));
assert.equal(
  validator.assertTerraformPlanPolicy(known, canonical, draft, inputFingerprint).mode,
  "known",
  "known container definitions are validated directly",
);

const unknown = validator.assertTerraformPlanPolicy(
  plan(null, true),
  canonical,
  draft,
  inputFingerprint,
);
assert.equal(unknown.mode, "unknown_canonical_equivalence");
assert.equal(unknown.auditAction, "PLAN_TASK_DEFINITION_UNKNOWN_CANONICAL_EQUIVALENCE_USED");
assert.equal(unknown.taskDefinitionDraftFingerprint, draft.draftFingerprint);

assert.throws(
  () => validator.assertTerraformPlanPolicy(
    plan(null, true),
    canonical,
    { ...draft, terraformInputFingerprint: "different-input" },
    inputFingerprint,
  ),
  /equivalence cannot be proven/,
);
assert.throws(
  () => validator.assertTerraformPlanPolicy(plan("{bad-json"), canonical, draft, inputFingerprint),
  /malformed/,
);
assert.throws(
  () => validator.assertTerraformPlanPolicy(plan(undefined, false, false), canonical, draft, inputFingerprint),
  /absent/,
);
assert.throws(
  () => validator.assertTerraformPlanPolicy(plan({ computed: true }), canonical, draft, inputFingerprint),
  /unsupported type/,
);

console.log("Terraform unknown/known/malformed/absent plan policy verification passed");
