import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  aliasesFor,
  isPlatformProjectProhibited,
  isSecretConfigurationKey,
  normalizeConfigurationKey,
  SERVICE_ALIAS_GROUPS,
  serviceAlias,
} from "../src/projects/configuration-ownership";

const root = join(process.cwd(), "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");

function verifyAliases() {
  assert.equal(normalizeConfigurationKey(" postgres_host "), "POSTGRES_HOST");
  for (const key of ["DB_HOST", "DATABASE_HOST", "POSTGRES_HOST", "PGHOST"]) assert.equal(serviceAlias(key, "postgres")?.property, "host");
  for (const key of ["DB_PASSWORD", "DATABASE_PASSWORD", "POSTGRES_PASSWORD", "PGPASSWORD"]) {
    assert.equal(serviceAlias(key, "postgres")?.property, "password");
    assert.equal(isSecretConfigurationKey(key), true);
  }
  assert.deepEqual([...aliasesFor("mysql", "url")], ["DATABASE_URL", "MYSQL_URL"]);
  assert.equal(serviceAlias("REDIS_URL", "redis")?.secret, true);
  assert.equal(serviceAlias("MONGODB_URI", "mongodb")?.property, "url");
  assert.equal(serviceAlias("MEDIA_ROOT", "storage")?.property, "path");
  assert.ok(SERVICE_ALIAS_GROUPS.every((group) => group.aliases.length > 0));
}

function verifyPlatformSeparation() {
  for (const key of ["AWS_SECRET_ACCESS_KEY", "GOOGLE_AI_API_KEY", "INFRACOST_API_KEY", "STRIPE_WEBHOOK_SECRET", "DEPLOYGUARD_INTERNAL_TOKEN"]) {
    assert.equal(isPlatformProjectProhibited(key), true, key);
  }
  for (const key of ["APP_SIGNING_SECRET", "THIRD_PARTY_API_KEY", "OPTIONAL_FEATURE"]) assert.equal(isPlatformProjectProhibited(key), false, key);
  const requirements = read("backend/src/projects/deployment-requirements.service.ts");
  assert.doesNotMatch(requirements, /NotificationSettings|ProjectNotification|BillingService|StripeService/);
}

function verifySingleResolverConsumers() {
  const resolver = read("backend/src/infrastructure/database-service-binding.service.ts");
  assert.match(resolver, /resolveEffectiveDeploymentConfiguration\(/);
  assert.match(resolver, /createRunConfigurationSnapshot/);
  assert.match(resolver, /encryptedSecretPayload/);
  for (const path of [
    "backend/src/projects/templates/preflight.service.ts",
    "backend/src/infrastructure/infrastructure.service.ts",
    "backend/src/projects/recovery/stage-checkpoint.service.ts",
    "backend/src/projects/pipeline/pipeline-worker.service.ts",
  ]) assert.match(read(path), /effectiveConfiguration|databaseBindings/, path);
  const pipeline = read("backend/src/projects/pipeline/pipeline.service.ts");
  const worker = read("backend/src/projects/pipeline/pipeline-worker.service.ts");
  const resume = read("backend/src/projects/recovery/stage-selective-resume.service.ts");
  assert.match(pipeline, /createRunConfigurationSnapshot/);
  assert.match(resume, /createRunConfigurationSnapshot/);
  const buildResolver = worker.slice(worker.indexOf("private async publicBuildArguments"), worker.indexOf("private async checkDockerfile"));
  assert.match(buildResolver, /resolveEffectiveDeploymentConfiguration/);
  assert.doesNotMatch(buildResolver, /environmentVariableRepository|createQueryBuilder/);
  assert.match(resolver, /projectId, environment, contractHash/);
  assert.match(resolver, /persistent storage binding/);
  assert.match(resolver, /runtimeVariables\[key\] = "\/app\/data"/);
  assert.match(read("backend/src/projects/projects.service.ts"), /managedAliasError\(normalized, "storage"\)/);
}

function verifySecretsAndMigration() {
  const variable = read("backend/src/projects/project-environment-variable.entity.ts");
  const snapshot = read("backend/src/projects/project-configuration-snapshot.entity.ts");
  const migration = read("backend/src/migrations/1760000033000-CanonicalProjectConfiguration.ts");
  assert.match(variable, /select: false, type: "text"/);
  assert.match(snapshot, /encrypted_secret_payload/);
  assert.match(snapshot, /build_values/);
  assert.match(snapshot, /@Unique\(\["pipelineRunId"\]\)/);
  assert.match(migration, /Superseded by DeployGuard-managed service binding/);
  for (const alias of ["PGHOST", "PGPASSWORD", "MYSQL_HOST", "MYSQL_PASSWORD", "POSTGRESQL_URL"]) assert.match(migration, new RegExp(alias));
  assert.doesNotMatch(migration, /DELETE FROM "project_environment_variables"/);
  const response = read("backend/src/projects/projects.service.ts");
  assert.match(response, /maskedValue: "••••••••"/);
  assert.doesNotMatch(response.slice(response.indexOf("private toEnvVarResponse"), response.indexOf("private async environmentDefaults")), /value: variable\.value/);
}

function verifyUiOwnership() {
  const preflight = read("frontend/src/pages/ProjectPreflight.jsx");
  const requirements = read("frontend/src/pages/DeploymentRequirements.jsx");
  const environmentRoute = read("frontend/src/routes/ProjectEnvironmentRoute.jsx");
  const custom = read("frontend/src/pages/ProjectEnvVars.jsx");
  assert.doesNotMatch(preflight, /EnvironmentVariablesPanel|DatabaseTierSettings/);
  assert.match(requirements, /Required application configuration/);
  assert.match(requirements, /All required application configuration is complete/);
  assert.doesNotMatch(requirements, /Add all environment variables/);
  assert.match(requirements, /externalInputMode/);
  assert.match(environmentRoute, /isDeveloperMode/);
  assert.match(custom, /Custom application variables/);
  const settings = read("frontend/src/pages/ProjectSettings.jsx");
  assert.doesNotMatch(settings, /requiredEnvironmentVariables/);
  assert.doesNotMatch(settings, /Required environment keys/);
  const detection = read("backend/src/projects/detection/stack-detection.service.ts");
  assert.doesNotMatch(detection, /overrides\.requiredEnvironmentVariables/);
  const contract = read("backend/src/projects/deployment-contract.service.ts");
  assert.match(contract, /repositoryRequired/);
  assert.doesNotMatch(contract, /project\.deploymentOverrides\?\.requiredEnvironmentVariables/);
  const terraform = read("backend/terraform/base-network/main.tf");
  assert.match(terraform, /database_secret_alias_types/);
  assert.match(terraform, /secret_type == "url"/);
}

verifyAliases();
verifyPlatformSeparation();
verifySingleResolverConsumers();
verifySecretsAndMigration();
verifyUiOwnership();
console.log("Canonical configuration ownership, alias protection, immutable snapshots, secret safety, and UI separation passed.");
