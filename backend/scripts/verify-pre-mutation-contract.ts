import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DeploymentContractValidationService,
} from "../src/infrastructure/deployment-contract-validation.service";

const validator = new DeploymentContractValidationService();
const projectId = "846665b9-ce31-405d-a131-b84457d80932";
const binding = {
  id: "binding-v2",
  projectId,
  provider: "managed",
  engine: "postgres",
  hostReference: `db.project-${projectId}.deployguard.local`,
  configurationFingerprint: "binding-revision-v2",
} as any;

function contract(withUrl = false) {
  const url = withUrl ? ["DATABASE_URL"] : [];
  return {
    projectId,
    contractHash: withUrl ? "repository-contract-url" : "repository-contract-password",
    databaseRequired: true,
    databaseEngine: "postgres",
    requiredEnvVars: ["DB_PASSWORD", ...url],
    optionalEnvVars: [],
    runtimeEnvVars: ["DB_PASSWORD", ...url],
    buildTimeEnvVars: [],
    ecsPlan: {
      containerPort: 5000,
      healthCheckPath: "/api/health",
      environmentMappings: [
        { name: "DB_HOST", source: "platform" },
        { name: "DB_PORT", source: "platform" },
        { name: "DB_NAME", source: "platform" },
        { name: "DB_USER", source: "platform" },
      ],
      secretMappings: [
        { name: "DB_PASSWORD", source: "platform_secret" },
        ...(withUrl ? [{ name: "DATABASE_URL", source: "platform_secret" }] : []),
      ],
    },
  } as any;
}

function effective(overrides: Record<string, unknown> = {}) {
  const ownership = {
    DB_HOST: owner(false),
    DB_PORT: owner(false),
    DB_NAME: owner(false),
    DB_USER: owner(false),
    DB_PASSWORD: owner(true),
  };
  return {
    binding,
    environment: "production",
    plainEnvironmentValues: {
      DB_HOST: binding.hostReference,
      DB_PORT: "5432",
      DB_NAME: "cattle_farm_db",
      DB_USER: "dg_user",
    },
    buildArguments: {},
    runtimeVariables: {
      DB_HOST: binding.hostReference,
      DB_PORT: "5432",
      DB_NAME: "cattle_farm_db",
      DB_USER: "dg_user",
    },
    projectSecretValues: {},
    secretReferences: { DB_PASSWORD: "terraform://database/password" },
    ownership,
    serviceBindingRevisions: [],
    unresolvedRequiredValues: [],
    prohibitedOverrides: [],
    duplicateOwnershipConflicts: [],
    configurationFingerprint: "effective-configuration-v2",
    blockers: [],
    sanitizedDeveloperManifest: {},
    ...overrides,
  } as any;
}

function owner(secret: boolean) {
  return {
    owner: "managed_service",
    source: "postgres service binding",
    sourceRevision: binding.id,
    required: true,
    secret,
    protected: true,
    serviceBindingId: binding.id,
    detectedReference: "repository-scan-v1",
  };
}

function canonical(c = contract(), e = effective()) {
  return validator.buildCanonicalContract(projectId, "production", c, e, "sha256:image");
}

const validContract = contract();
const validEffective = effective();
const validCanonical = canonical(validContract, validEffective);
assert.deepEqual(validator.validateSemantic(projectId, validContract, validEffective, validCanonical), []);
assert.equal(validCanonical.runtimeEntries.find((item) => item.key === "DB_PASSWORD")?.destination, "ecs_secret");
assert.equal(validCanonical.runtimeEntries.some((item) => item.key === "DATABASE_URL"), false, "DATABASE_URL is omitted without repository evidence");
assert.equal(JSON.stringify(validCanonical).includes("secret-value"), false, "canonical metadata contains no secret plaintext");

const plaintextPassword = effective({
  runtimeVariables: { ...validEffective.runtimeVariables, DB_PASSWORD: "secret-value" },
});
assert(validator.validateSemantic(projectId, validContract, plaintextPassword, canonical(validContract, plaintextPassword))
  .some((item) => item.code === "managed_secret_plaintext" || item.code === "secret_in_plain_environment"));

const urlContract = contract(true);
const urlEffective = effective({
  secretReferences: {
    DB_PASSWORD: "terraform://database/password",
    DATABASE_URL: "terraform://database/url",
  },
  ownership: {
    ...validEffective.ownership,
    DATABASE_URL: owner(true),
  },
});
const urlCanonical = canonical(urlContract, urlEffective);
assert.deepEqual(validator.validateSemantic(projectId, urlContract, urlEffective, urlCanonical), []);
assert.equal(urlCanonical.runtimeEntries.find((item) => item.key === "DATABASE_URL")?.destination, "ecs_secret");

const forcedUrl = effective({
  secretReferences: {
    DB_PASSWORD: "terraform://database/password",
    DATABASE_URL: "terraform://database/url",
  },
  ownership: {
    ...validEffective.ownership,
    DATABASE_URL: owner(true),
  },
});
assert(validator.validateSemantic(projectId, validContract, forcedUrl, canonical(validContract, forcedUrl))
  .some((item) => item.code === "database_url_without_evidence"));

const invalidScope = effective({ binding: { ...binding, projectId: "another-project" } });
assert(validator.validateSemantic(projectId, validContract, invalidScope, canonical(validContract, invalidScope))
  .some((item) => item.code === "binding_scope_mismatch"));

const localhost = effective({
  binding: { ...binding, hostReference: "localhost" },
  runtimeVariables: { ...validEffective.runtimeVariables, DB_HOST: "localhost" },
});
assert(validator.validateSemantic(projectId, validContract, localhost, canonical(validContract, localhost))
  .some((item) => item.code === "managed_database_localhost"));

const validVariables = {
  ecs_environment_variables: validEffective.runtimeVariables,
  ecs_secret_environment_variables: {},
  database_secret_alias_types: { DB_PASSWORD: "password" },
};
const validInputFingerprint = validator.terraformInputFingerprint(validVariables, validCanonical);
const validDraft = validator.taskDefinitionDraft(validVariables, validCanonical.contractFingerprint, validInputFingerprint);
validator.assertRenderedDraft(validCanonical, validDraft);
assert.throws(
  () => validator.assertRenderedDraft(validCanonical, {
    ...validDraft,
    environmentNames: [...validDraft.environmentNames, "DB_PASSWORD"],
  }),
  /plaintext ECS environment|both ECS environment and secrets/,
);

const plan = JSON.stringify({
  planned_values: {
    root_module: {
      child_modules: [{
        resources: [{
          type: "aws_ecs_task_definition",
          name: "app",
          values: {
            container_definitions: JSON.stringify([{
              name: "app",
              environment: validDraft.environmentNames.map((name) => ({ name, value: "redacted-test-value" })),
              secrets: validDraft.secretNames.map((name) => ({ name, valueFrom: "managed-reference" })),
            }]),
          },
        }],
      }],
    },
  },
});
validator.assertTerraformPlanPolicy(plan, validCanonical, validDraft, validInputFingerprint);
const badPlan = JSON.stringify({
  planned_values: {
    root_module: {
      child_modules: [{
        resources: [{
          type: "aws_ecs_task_definition",
          name: "app",
          values: {
            container_definitions: JSON.stringify([{
              name: "app",
              environment: validDraft.environmentNames.map((name) => ({ name, value: "redacted-test-value" })),
              secrets: [],
            }]),
          },
        }],
      }],
    },
  },
});
assert.throws(() => validator.assertTerraformPlanPolicy(badPlan, validCanonical, validDraft, validInputFingerprint), /policy failed/);

const firstInput = validator.terraformInputFingerprint(validVariables, validCanonical);
const changedBindingEffective = effective({
  configurationFingerprint: "effective-configuration-v3",
  binding: { ...binding, configurationFingerprint: "binding-revision-v3" },
  ownership: Object.fromEntries(Object.entries(validEffective.ownership).map(([key, value]) => [
    key,
    { ...(value as Record<string, unknown>), serviceBindingId: binding.id },
  ])),
});
const changedCanonical = canonical(validContract, changedBindingEffective);
assert.notEqual(changedCanonical.contractFingerprint, validCanonical.contractFingerprint, "binding revision invalidates the contract fingerprint");
assert.notEqual(
  validator.terraformInputFingerprint(validVariables, changedCanonical),
  firstInput,
  "binding revision invalidates Terraform inputs without changing the image",
);
assert.notEqual(
  validator.planFingerprint("artifact", firstInput, "run", validCanonical.contractFingerprint),
  validator.planFingerprint("artifact", firstInput, "run", changedCanonical.contractFingerprint),
  "plan fingerprint embeds the contract fingerprint",
);

const infrastructure = readFileSync(join(process.cwd(), "src/infrastructure/infrastructure.service.ts"), "utf8");
const runnerCallers = [...infrastructure.matchAll(/runTerraformApply\(/g)].length;
assert.equal(runnerCallers, 1, "Terraform apply has one canonical production caller");
assert(
  infrastructure.indexOf("buildValidatedTerraformInputs") < infrastructure.indexOf("runTerraformPlan(workdir"),
  "pre-mutation validation executes before Terraform plan",
);
assert(
  infrastructure.indexOf("buildValidatedTerraformInputs(project, contract, pipelineRunId)") < infrastructure.indexOf("validateCredentials()"),
  "apply validation executes before AWS credential or mutation work",
);

console.log("Pre-mutation deployment contract, ECS secret mapping, plan policy, and fingerprint safety verification passed.");
