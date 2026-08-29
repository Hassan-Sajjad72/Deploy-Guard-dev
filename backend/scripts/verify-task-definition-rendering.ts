import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";
import { DeploymentContractValidationService } from "../src/infrastructure/deployment-contract-validation.service";

async function main() {
  const validator = new DeploymentContractValidationService();
  const canonical: any = {
    contractFingerprint: "contract-fingerprint",
    runtimeEntries: [
      { key: "DB_HOST", destination: "ecs_environment", sensitivity: "non_secret", owner: "managed_service" },
      { key: "DB_NAME", destination: "ecs_environment", sensitivity: "non_secret", owner: "managed_service" },
      { key: "DB_USER", destination: "ecs_environment", sensitivity: "non_secret", owner: "managed_service" },
      { key: "DB_PASSWORD", destination: "ecs_secret", sensitivity: "secret", owner: "managed_service" },
    ],
  };
  const variables = {
    ecs_environment_variables: {
      DB_HOST: "database.internal",
      DB_NAME: "app",
      DB_USER: "deployguard",
    },
    ecs_secret_environment_variables: {},
    database_secret_alias_types: { DB_PASSWORD: "password" },
  };
  const inputFingerprint = validator.terraformInputFingerprint(variables, canonical);
  const draft = validator.taskDefinitionDraft(variables, canonical.contractFingerprint, inputFingerprint);
  validator.assertRenderedDraft(canonical, draft);
  assert(draft.secretNames.includes("DB_PASSWORD"));
  assert.equal(draft.environmentNames.includes("DB_PASSWORD"), false);
  assert.equal(draft.secretNames.includes("DATABASE_URL"), false);
  assert.equal(draft.environmentNames.includes("DATABASE_URL"), false);

  const [rootModule, ecsModule] = await Promise.all([
    readFile("terraform/base-network/main.tf", "utf8"),
    readFile("terraform/modules/ecs-service/main.tf", "utf8"),
  ]);
  assert.match(rootModule, /environment_variables\s*=\s*var\.ecs_environment_variables/);
  assert.match(rootModule, /secret_environment_variables\s*=\s*var\.ecs_secret_environment_variables/);
  assert.match(rootModule, /for key, secret_type in var\.database_secret_alias_types/);
  assert.match(ecsModule, /for key, value in var\.environment_variables/);
  assert.match(ecsModule, /keys\(var\.secret_environment_variables\)/);
  assert.match(ecsModule, /environment\s*=\s*local\.env_list/);
  assert.match(ecsModule, /secrets\s*=\s*concat\(local\.secret_list, local\.external_secret_list\)/);

  const infrastructureSource = await readFile("src/infrastructure/infrastructure.service.ts", "utf8");
  assert.doesNotMatch(infrastructureSource, /terraformShowJson\s*:/);
  assert.doesNotMatch(infrastructureSource, /planJson\s*:\s*show\.stdout/);
  console.log("Canonical ECS task-definition rendering verification passed");
}

void main();
