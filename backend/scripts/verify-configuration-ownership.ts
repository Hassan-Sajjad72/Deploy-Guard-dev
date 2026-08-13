import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  aliasesFor,
  classifyConfigurationVariable,
  isPlatformProjectProhibited,
  isSecretConfigurationKey,
  normalizeConfigurationKey,
  platformRuntimeVariableNames,
  RESERVED_VARIABLE_REGISTRY,
  reservedVariable,
  reservedVariableError,
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
  for (const key of ["PORT", "HOST", "NODE_ENV", "AWS_REGION", "DEPLOYGUARD_PROJECT_ID", "DEPLOYGUARD_OPERATION_ID", "DEPLOYGUARD_APP_LOG_GROUP"]) {
    assert.ok(reservedVariable(key), `${key} must be centrally reserved`);
  }
  assert.equal(reservedVariable("DATABASE_URL", "postgres")?.category, "runtime_secret");
  assert.equal(reservedVariable("DB_HOST", "postgres")?.category, "infrastructure_generated");
  assert.equal(reservedVariable("VITE_PUBLIC_API"), null);
  assert.deepEqual(reservedVariableError("PORT").code, "RESERVED_ENVIRONMENT_VARIABLE");
  assert.ok(platformRuntimeVariableNames("javascript", "server").includes("NODE_ENV"));
  assert.ok(!platformRuntimeVariableNames("python", "server").includes("NODE_ENV"));
  assert.equal(new Set(RESERVED_VARIABLE_REGISTRY.map((item) => item.key)).size, RESERVED_VARIABLE_REGISTRY.length);
  assert.deepEqual(classifyConfigurationVariable("PORT"), { key: "PORT", management: "platform_managed", delivery: "runtime_public" });
  assert.deepEqual(classifyConfigurationVariable("DB_PASSWORD", { service: "postgres" }), { key: "DB_PASSWORD", management: "infrastructure_generated", delivery: "runtime_secret" });
  assert.deepEqual(classifyConfigurationVariable("VITE_PUBLIC_API", { scope: "build" }), { key: "VITE_PUBLIC_API", management: "user_defined", delivery: "build_time_public" });
  assert.deepEqual(classifyConfigurationVariable("APP_SECRET", { secret: true }), { key: "APP_SECRET", management: "user_defined", delivery: "runtime_secret" });
  assert.deepEqual(classifyConfigurationVariable("FEATURE_FLAG"), { key: "FEATURE_FLAG", management: "user_defined", delivery: "runtime_public" });
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
  assert.match(resolver, /projectId, environment, generationId, contractHash/);
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
  assert.match(read("backend/src/orchestration-contracts/entities/release-manifest.entity.ts"), /configuration_snapshot_id/);
  assert.match(read("backend/src/orchestration-contracts/contracts/release-manifest.types.ts"), /configurationSnapshotId/);
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
  const custom = read("frontend/src/components/projects/EnvironmentVariablesPanel.jsx");
  assert.doesNotMatch(preflight, /EnvironmentVariablesPanel|DatabaseTierSettings/);
  assert.match(requirements, /Manage required configuration/);
  assert.match(requirements, /All required application configuration is complete/);
  assert.doesNotMatch(requirements, /Add all environment variables/);
  assert.match(requirements, /externalInputMode/);
  assert.match(environmentRoute, /Navigate replace to=.*requirements/);
  assert.match(requirements, /EnvironmentVariablesPanel/);
  assert.match(custom, /Additional variables/);
  assert.match(custom, /Managed by DeployGuard/);
  assert.match(custom, /reservedVariables/);
  assert.match(read("frontend/src/components/projects/EnvVarTable.jsx"), /!variable\.protected && !variable\.isRequired/);
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

function verifyAllWriteBoundaries() {
  const projects = read("backend/src/projects/projects.service.ts");
  assert.match(projects, /ignoredEnvironmentVariableNames\(project\.id, \[key\]/);
  assert.match(projects, /partitionSubmittedEnvironmentVariables\(normalized/);
  assert.match(projects, /ignoredVariableNames/);
  assert.match(projects, /const current = await this\.findEnvVar[\s\S]*this\.assertVariableMutable\(current\)[\s\S]*\.remove\(current\)/);
  assert.match(projects, /provenRepositoryOwnedVariableKeys/);
  const requirements = read("backend/src/projects/deployment-requirements.service.ts");
  assert.match(requirements, /submittedKeys/);
  assert.match(requirements, /ignoredVariableNames/);
  const resolver = read("backend/src/infrastructure/database-service-binding.service.ts");
  assert.match(resolver, /DEPLOYGUARD_OPERATION_ID/);
  assert.match(resolver, /ownershipManifest/);
  assert.doesNotMatch(read("frontend/src/components/projects/EnvVarTable.jsx"), /variable\.value/);
}

verifyAliases();
verifyPlatformSeparation();
verifySingleResolverConsumers();
verifySecretsAndMigration();
verifyUiOwnership();
verifyAllWriteBoundaries();
console.log("Canonical configuration ownership, alias protection, immutable snapshots, secret safety, and UI separation passed.");
