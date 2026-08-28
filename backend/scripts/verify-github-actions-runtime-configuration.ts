import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decodeEnvironmentReferencesBase64,
  environmentReferencesBase64,
  GithubActionsRuntimeConfiguration,
  runtimeConfigurationWithPromotionCandidate,
} from "../src/projects/github-actions-operation-contract";
import { GithubActionsCandidateEvidence } from "../src/projects/github-actions-promotion-evidence";
import {
  RuntimeSecretDescription,
  RuntimeSecretMaterializationPort,
  RuntimeSecretMaterializer,
} from "../src/projects/github-actions-runtime-secret.service";
import { extractGithubActionsReleaseEvidence } from "../src/projects/github-actions-release-evidence";
import { MANAGED_DATABASE_ENGINE_PROFILES } from "../src/projects/managed-database-engine";
import {
  canonicalManagedDatabaseOwnerComponentId,
  GithubActionsDeploymentService,
  missingComponentRuntimeRequirements,
} from "../src/projects/github-actions-deployment.service";
import { BuildPlan } from "../src/projects/build-plan";

const projectId = "11111111-2222-4333-8444-555555555555";
const generationId = "11111111-1111-4111-8111-111111111111";
const snapshotId = "66666666-7777-4888-8999-aaaaaaaaaaaa";
const bindingId = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff";
const fingerprint = "1".repeat(64);
const bindingFingerprint = "2".repeat(64);
const secretValue = "never-print-this-secret-value";
const secretArn = `arn:aws:secretsmanager:us-east-1:563149050793:secret:deployguard/${projectId}/dev/application/runtime-AbCdEf`;

const configuration: GithubActionsRuntimeConfiguration = {
  schemaVersion: 1,
  configurationSnapshotId: snapshotId,
  configurationFingerprint: fingerprint,
  projectId,
  environmentName: "dev",
  generationId,
  generationStateKey: `projects/${projectId}/dev/${generationId}/terraform.tfstate`,
  platformFoundation: {
    vpcId: "vpc-12345678",
    publicSubnetIds: ["subnet-11111111", "subnet-22222222"],
    ecsClusterArn: "arn:aws:ecs:us-east-1:563149050793:cluster/deployguard-shared",
    ecsClusterName: "deployguard-shared",
    albArn: "arn:aws:elasticloadbalancing:us-east-1:563149050793:loadbalancer/app/deployguard/1234567890abcdef",
    albDnsName: "deployguard.example.com",
    listenerArn: "arn:aws:elasticloadbalancing:us-east-1:563149050793:listener/app/deployguard/1234567890abcdef/1234567890abcdef",
    albSecurityGroupId: "sg-12345678",
  },
  routing: { listenerPriority: 1001, verificationPriority: 21001, productionHost: `p-${projectId}.example.com`, candidateHost: `g-${generationId}.example.com` },
  projectPersistence: { stateKey: `projects/${projectId}/dev/project/terraform.tfstate`, ecrRepositoryName: `deployguard-${projectId}`, runtimeSecretName: `deployguard/${projectId}/dev/application/runtime`, ownershipScope: "project" },
  retiredGenerationCleanup: null,
  environment: {
    JWT_EXPIRES_IN: "1h",
    DB_HOST: `db.project-${projectId}.deployguard.local`,
    DB_PORT: "5432",
    DB_NAME: "app",
    DB_USER: "dg_user",
  },
  secretReferences: { JWT_SECRET: `${secretArn}:JWT_SECRET::` },
  componentRuntime: {
    application: {
      environment: {
        HOST: "0.0.0.0",
        PORT: "3000",
        NODE_ENV: "production",
        DEPLOYGUARD_PROJECT_ID: projectId,
        DEPLOYGUARD_GENERATION_ID: generationId,
        DEPLOYGUARD_ENVIRONMENT: "dev",
        DEPLOYGUARD_OPERATION_ID: "77777777-7777-4777-8777-777777777777",
        JWT_EXPIRES_IN: "1h",
      },
      secretReferences: { JWT_SECRET: `${secretArn}:JWT_SECRET::` },
    },
  },
  deploymentContext: { schemaVersion: 1, deploymentMode: "FRESH", persistentState: "NONE", recoveryState: "NOT_REQUIRED", recoveryRequired: false, recoveryEvidenceAvailable: false, persistentPreviouslyEstablished: false, deploymentAllowed: true, reason: "Fresh fixture." },
  retentionProtectedRelease: {
    imageDigests: [`sha256:${"a".repeat(64)}`],
    taskDefinitionArns: ["arn:aws:ecs:us-east-1:563149050793:task-definition/dg-fixture:7"],
  },
  promotion: {
    contractVersion: "deployguard.promotion-intent/v1",
    operationId: "77777777-7777-4777-8777-777777777777",
    projectId,
    environmentName: "dev",
    generationId,
    candidate: null,
    previousLiveGenerationId: null,
    previousTargetGroupArn: null,
    previousListenerRuleArn: null,
    previousProductionUrl: null,
    intentFingerprint: null,
  },
  managedDatabase: {
    bindingId,
    bindingFingerprint,
    provider: "managed",
    engine: "postgres",
    ownerComponentId: "application",
    host: `db.project-${projectId}.deployguard.local`,
    port: 5432,
    databaseName: "app",
    databaseUser: "dg_user",
    runtimeAliases: { DB_HOST: `db.project-${projectId}.deployguard.local`, DB_PORT: "5432", DB_NAME: "app", DB_USER: "dg_user" },
    secretAliases: { DATABASE_URL: "url", DB_PASSWORD: "password" },
    persistenceEnabled: true,
  },
};

class Port implements RuntimeSecretMaterializationPort {
  description: RuntimeSecretDescription | null = null;
  creates = 0;
  restores = 0;
  puts = 0;
  activations = 0;
  async describe() { return this.description; }
  async create(name: string, _secretString: string, versionToken: string, tags: Record<string, string>) {
    this.creates += 1;
    this.description = { arn: secretArn, name, deletionDate: null, tags, versions: { [versionToken]: ["AWSCURRENT"] } };
    return secretArn;
  }
  async restore() { this.restores += 1; if (this.description) this.description.deletionDate = null; }
  async put(_arn: string, _secretString: string, versionToken: string) {
    this.puts += 1;
    if (this.description) this.description.versions[versionToken] = ["AWSCURRENT"];
  }
  async activateVersion(_arn: string, versionToken: string) {
    this.activations += 1;
    if (this.description) this.description.versions[versionToken] = ["AWSCURRENT"];
  }
}

function freshManagedDatabasePlan(engine: "postgres" | "mysql" | "mongodb", ownerComponentId: "backend" | "application", aliases: string[]): BuildPlan {
  const owner = {
    id: ownerComponentId,
    role: ownerComponentId === "backend" ? "backend" : "application",
    root: "server", buildContext: "server", repositoryInstallRoot: "server", detectorId: `${engine}-fixture`, language: "javascript",
    framework: "fixture", frameworkMode: "server", runtimeType: "server", packageManager: "npm", dependencyManifest: "package.json",
    lockfile: "package-lock.json", runtimeVersion: "22", baseImage: "node:22-alpine", runtimeImage: "node:22-alpine",
    installCommand: "npm ci", buildCommand: null, runCommand: "node server.js", runtimeFiles: [], outputDirectory: null,
    port: 3000, healthPath: "/health", healthCheckMode: "http", bindHost: "0.0.0.0", bindsToPortEnv: true,
    dockerStrategy: "generated", dockerTemplate: "node", database: { required: true, provider: "managed", engine },
    environmentOwnership: aliases.map((key) => ({ key, owner: "infrastructure", componentId: ownerComponentId, source: "managed_database", exposure: "private", requirement: "required", required: true, phase: "runtime", secret: /(?:URL|PASSWORD)$/.test(key) })),
  } as const;
  const frontend = {
    ...owner, id: "frontend" as const, role: "frontend" as const, root: "web", buildContext: "web", repositoryInstallRoot: "web",
    database: { required: false, provider: "none", engine: null }, environmentOwnership: [],
  } as const;
  return {
    planVersion: 2, detectorVersion: "fixture", repositoryFullName: "fixture/deferred-database", branch: "main", commitSha: "a".repeat(40),
    detectorId: "fixture", language: "javascript", framework: "fixture", frameworkMode: "server", confidence: "high", platformBackendMount: "/__deployguard/backend",
    evidence: [{ source: "detector", description: `${engine} required aliases` }], appRoot: "server", repositoryInstallRoot: "server", packageManager: "npm", dependencyManifest: "package.json", lockfile: "package-lock.json", runtimeVersion: "22", baseImage: "node:22-alpine", runtimeImage: "node:22-alpine", installCommand: "npm ci", buildCommand: null, buildCommands: [], releaseCommand: null, releaseCommands: [], runCommand: "node server.js", runtimeFiles: [], outputDirectory: null, buildSystemDependencies: [], runtimeSystemDependencies: [], port: 3000, portSource: "detector", healthPath: "/health", bindHost: "0.0.0.0", bindsToPortEnv: true, runtimeType: "server", database: owner.database, environmentOwnership: owner.environmentOwnership, requiredInputs: aliases, requiredUserInputs: [], optionalInputs: [], buildTimeEnvVars: [], runtimeEnvVars: aliases, secretEnvVars: aliases.filter((key) => /(?:URL|PASSWORD)$/.test(key)), dockerStrategy: "generated", dockerTemplate: "node", warnings: [], blockers: [], components: [frontend, owner] as any, serviceBindings: [], relationships: [],
  } as BuildPlan;
}

function verifyFreshManagedDatabaseHandoff() {
  const cases: Array<{ engine: "postgres" | "mysql" | "mongodb"; owner: "backend" | "application"; aliases: string[] }> = [
    { engine: "postgres", owner: "backend", aliases: ["DATABASE_URL", "DB_PASSWORD", "POSTGRES_PASSWORD"] },
    { engine: "mysql", owner: "application", aliases: ["DATABASE_URL", "DB_PASSWORD", "MYSQL_PASSWORD"] },
    { engine: "mongodb", owner: "backend", aliases: ["MONGODB_URI", "DB_PASSWORD"] },
  ];
  for (const fixture of cases) {
    const plan = freshManagedDatabasePlan(fixture.engine, fixture.owner, fixture.aliases);
    const profile = MANAGED_DATABASE_ENGINE_PROFILES[fixture.engine];
    const secretAliases = Object.fromEntries(fixture.aliases.map((alias) => [alias, /(?:URL|URI)$/.test(alias) ? "url" : "password" as const])) as Record<string, "password" | "url">;
    const freshBindingIntent = Object.fromEntries(fixture.aliases.map((alias) => [alias, `terraform://database/${secretAliases[alias]}`]));
    assert.equal(canonicalManagedDatabaseOwnerComponentId(plan), fixture.owner, `${fixture.engine} selects the BuildPlan database consumer, not the first component or role`);
    assert.deepEqual(missingComponentRuntimeRequirements({ componentId: fixture.owner, required: fixture.aliases, environment: {}, secretReferences: {}, managedDatabase: { ownerComponentId: fixture.owner, secretAliases } }), [], `${fixture.engine} deferred aliases satisfy only their exact owner`);
    assert.deepEqual(missingComponentRuntimeRequirements({ componentId: "frontend", required: fixture.aliases, environment: {}, secretReferences: {}, managedDatabase: { ownerComponentId: fixture.owner, secretAliases } }), fixture.aliases, `${fixture.engine} cannot defer aliases to a different component`);
    const effective: any = {
      binding: { id: bindingId, configurationFingerprint: bindingFingerprint, provider: "managed", engine: fixture.engine, hostReference: `db.${fixture.engine}.internal`, port: profile.port, databaseName: "app", usernameReference: "dg_user" },
      projectSecretValues: {}, secretReferences: freshBindingIntent,
      ownership: Object.fromEntries(fixture.aliases.map((alias) => [alias, { serviceBindingId: bindingId, secret: /(?:URL|URI|PASSWORD)$/.test(alias) }])),
    };
    const snapshot: any = { id: snapshotId, environment: "dev", configurationFingerprint: fingerprint, plainValues: {} };
    const runtime = (GithubActionsDeploymentService.prototype as any).runtimeConfiguration.call({
      platformFoundation: () => configuration.platformFoundation,
      deploymentGenerations: { verificationPriority: () => configuration.routing.verificationPriority },
      config: { get: (_key: string, fallback?: string) => fallback || "deployguard.example.com" },
    }, plan, snapshot, effective, null, configuration.deploymentContext, { projectId, id: generationId, terraformStateKey: configuration.generationStateKey } as any, { listenerPriority: 1001 } as any, null, null, configuration.promotion.operationId, null) as GithubActionsRuntimeConfiguration;
    const serialized = decodeEnvironmentReferencesBase64(environmentReferencesBase64(runtime));
    assert.equal(serialized.managedDatabase?.ownerComponentId, fixture.owner);
    assert.deepEqual(serialized.managedDatabase?.secretAliases, secretAliases);
    assert.deepEqual(serialized.componentRuntime[fixture.owner].secretReferences, {}, `${fixture.engine} terraform placeholders must be deferred outside ECS runtime config`);
    assert.doesNotMatch(JSON.stringify(serialized.componentRuntime), /terraform:\/\//, `${fixture.engine} never serializes terraform:// as ECS valueFrom`);
    const terraformOutputs = { database_url_secret_arn: `${secretArn}:DATABASE_URL::`, database_password_secret_arn: `${secretArn}:DB_PASSWORD::` };
    const ecsValueFrom = Object.fromEntries(Object.entries(secretAliases).map(([alias, kind]) => [alias, kind === "url" ? terraformOutputs.database_url_secret_arn : terraformOutputs.database_password_secret_arn]));
    assert(Object.values(ecsValueFrom).every((value) => value.startsWith("arn:aws:secretsmanager:")), `${fixture.engine} ECS valueFrom comes only from Terraform output ARNs`);
    assert.doesNotMatch(JSON.stringify(ecsValueFrom), /terraform:\/\//);
  }
}

async function main() {
  verifyFreshManagedDatabaseHandoff();
  const encoded = environmentReferencesBase64(configuration);
  const decoded = decodeEnvironmentReferencesBase64(encoded);
  assert.deepEqual(decoded, decodeEnvironmentReferencesBase64(environmentReferencesBase64({ ...configuration, environment: Object.fromEntries(Object.entries(configuration.environment).reverse()) })));
  assert.equal(decoded.environment.JWT_EXPIRES_IN, "1h");
  assert.equal(decoded.secretReferences.JWT_SECRET, `${secretArn}:JWT_SECRET::`);
  assert.deepEqual(decoded.managedDatabase?.secretAliases, { DATABASE_URL: "url", DB_PASSWORD: "password" });
  assert.deepEqual(decoded.componentRuntime.application.secretReferences, { JWT_SECRET: `${secretArn}:JWT_SECRET::` }, "deferred managed database aliases must not enter ECS application secret references");
  assert.doesNotMatch(JSON.stringify(decoded.componentRuntime), /terraform:\/\/database/, "deferred database placeholders must never pass runtime serialization as ECS valueFrom");
  assert.deepEqual(decoded.retentionProtectedRelease, configuration.retentionProtectedRelease);
  assert.doesNotMatch(encoded, new RegExp(secretValue));
  assert.doesNotMatch(Buffer.from(encoded, "base64").toString("utf8"), new RegExp(secretValue), "decoded runtime configuration must contain references, never application credentials");
  assert.throws(() => environmentReferencesBase64({ ...configuration, environment: { ...configuration.environment, EMAIL_PASS: secretValue } }), /invalid/i,
    "password-like application values must fail closed if projected into plaintext runtime configuration");
  const emailSecretConfiguration = { ...configuration, secretReferences: { ...configuration.secretReferences, EMAIL_PASS: `${secretArn}:EMAIL_PASS::` } };
  const encodedEmailSecretConfiguration = environmentReferencesBase64(emailSecretConfiguration);
  assert.equal(decodeEnvironmentReferencesBase64(encodedEmailSecretConfiguration).secretReferences.EMAIL_PASS, `${secretArn}:EMAIL_PASS::`);
  assert.doesNotMatch(Buffer.from(encodedEmailSecretConfiguration, "base64").toString("utf8"), new RegExp(secretValue), "loggable base64 payload must not contain recoverable EMAIL_PASS credentials");
  assert.throws(() => decodeEnvironmentReferencesBase64(Buffer.from(JSON.stringify({ ...configuration, secretReferences: { JWT_SECRET: secretValue } })).toString("base64")), /invalid/i);
  assert.equal(decodeEnvironmentReferencesBase64(environmentReferencesBase64({ ...configuration, managedDatabase: null })).managedDatabase, null, "database-free applications must preserve a null managed database configuration");
  const failedCandidateCleanup: GithubActionsRuntimeConfiguration = {
    ...configuration,
    retiredGenerationCleanup: {
      generationId,
      terraformStateKey: configuration.generationStateKey,
      resourceManifest: {},
      cleanupReason: "failed_candidate",
    },
  };
  assert.equal(
    decodeEnvironmentReferencesBase64(environmentReferencesBase64(failedCandidateCleanup)).retiredGenerationCleanup?.cleanupReason,
    "failed_candidate",
    "an explicit failed-candidate cleanup may target only the runtime's exact generation state",
  );
  assert.throws(() => environmentReferencesBase64({
    ...configuration,
    retiredGenerationCleanup: { ...failedCandidateCleanup.retiredGenerationCleanup!, cleanupReason: "retired" },
  }), /invalid/i, "retired cleanup cannot target the current candidate generation");
  assert.throws(() => environmentReferencesBase64({
    ...configuration,
    retiredGenerationCleanup: {
      generationId: "99999999-9999-4999-8999-999999999999",
      terraformStateKey: `projects/${projectId}/dev/99999999-9999-4999-8999-999999999999/terraform.tfstate`,
      resourceManifest: {},
      cleanupReason: "failed_candidate",
    },
  }), /invalid/i, "failed-candidate cleanup cannot target another generation");
  for (const engine of ["postgres", "mysql", "mongodb"] as const) {
    const profile = MANAGED_DATABASE_ENGINE_PROFILES[engine];
    const engineConfiguration: GithubActionsRuntimeConfiguration = {
      ...configuration,
      environment: { ...configuration.environment, DB_PORT: String(profile.port) },
      managedDatabase: {
        ...configuration.managedDatabase!,
        engine,
        image: profile.image,
        port: profile.port,
        dataPath: profile.dataPath,
        healthCheck: profile.healthCheck,
        initializationEnvironment: profile.initializationEnvironment,
        initializationSecretNames: profile.initializationSecretNames,
        urlScheme: profile.urlScheme,
        urlQuery: profile.urlQuery,
        runtimeAliases: { ...configuration.managedDatabase!.runtimeAliases, DB_PORT: String(profile.port) },
        secretAliases: engine === "mongodb" ? { DB_PASSWORD: "password", MONGODB_URI: "url" } : configuration.managedDatabase!.secretAliases,
      },
    };
    assert.equal(decodeEnvironmentReferencesBase64(environmentReferencesBase64(engineConfiguration)).managedDatabase?.engine, engine);
    assert.throws(() => environmentReferencesBase64({
      ...engineConfiguration,
      managedDatabase: { ...engineConfiguration.managedDatabase!, port: profile.port + 1 },
    }), /invalid/i, `${engine} must fail closed on a mismatched port`);
    if (engine === "mongodb") {
      assert.throws(() => environmentReferencesBase64({
        ...engineConfiguration,
        managedDatabase: { ...engineConfiguration.managedDatabase!, healthCheck: ["CMD-SHELL", "mongosh --quiet --eval 'db.adminCommand({ ping: 0 })' >/dev/null"] },
      }), /invalid/i, "MongoDB must fail closed on a mismatched health check");
    }
  }

  const candidate: GithubActionsCandidateEvidence = {
    contractVersion: "deployguard.candidate-result/v2",
    deploymentOperationId: configuration.promotion.operationId,
    projectId,
    generationId,
    environmentName: "dev",
    commitSha: "a".repeat(40),
    candidateUrl: "http://candidate.example.test",
    imageUri: `563149050793.dkr.ecr.us-east-1.amazonaws.com/deployguard-app@sha256:${"b".repeat(64)}`,
    imageDigest: `sha256:${"b".repeat(64)}`,
    clusterName: "deployguard-shared",
    serviceName: "dg-candidate",
    ecsServiceArn: "arn:aws:ecs:us-east-1:563149050793:service/deployguard-shared/dg-candidate",
    targetGroupArn: "arn:aws:elasticloadbalancing:us-east-1:563149050793:targetgroup/dg-candidate/1234567890abcdef",
    candidateListenerRuleArn: "arn:aws:elasticloadbalancing:us-east-1:563149050793:listener-rule/app/dg-shared/1234567890abcdef/abcdef1234567890",
    taskDefinitionArn: "arn:aws:ecs:us-east-1:563149050793:task-definition/dg-candidate:7",
    appPort: 3000,
    healthCheckPath: "/health",
    configurationFingerprint: fingerprint,
    configurationSnapshotId: snapshotId,
    databaseBindingId: bindingId,
    secretReferenceNames: ["JWT_SECRET"],
    databaseOutputs: null,
    health: {
      ecsStable: true,
      expectedTaskDefinitionRunning: true,
      expectedImageRunning: true,
      relationshipVerificationStatus: "not_required",
      targetHealthVerified: true,
      candidateHttpVerified: true,
      healthyTargetCount: 1,
      targetStates: ["healthy"],
    },
  };
  const promotionConfiguration = runtimeConfigurationWithPromotionCandidate(decoded, candidate);
  assert.deepEqual(decodeEnvironmentReferencesBase64(environmentReferencesBase64(promotionConfiguration)), promotionConfiguration);
  assert.match(promotionConfiguration.promotion.intentFingerprint || "", /^[0-9a-f]{64}$/);
  assert.equal(promotionConfiguration.promotion.candidate, candidate);
  assert.throws(() => environmentReferencesBase64({
    ...promotionConfiguration,
    promotion: { ...promotionConfiguration.promotion, intentFingerprint: "0".repeat(64) },
  }), /invalid/i, "tampered promotion fingerprints must fail closed");

  const missing = new Port();
  const materializer = new RuntimeSecretMaterializer(missing, { attempts: 2, intervalMs: 0 });
  const first = await materializer.materialize({ projectId, generationId, environment: "dev", configurationFingerprint: fingerprint, secretValues: { JWT_SECRET: secretValue } });
  assert.equal(missing.creates, 1);
  assert.equal(first?.valueFromByName.JWT_SECRET, `${secretArn}:JWT_SECRET::`);
  await materializer.materialize({ projectId, generationId, environment: "dev", configurationFingerprint: fingerprint, secretValues: { JWT_SECRET: secretValue } });
  assert.deepEqual({ creates: missing.creates, restores: missing.restores, puts: missing.puts, activations: missing.activations }, { creates: 1, restores: 0, puts: 0, activations: 0 });
  const emailMaterialization = await new RuntimeSecretMaterializer(new Port(), { attempts: 2, intervalMs: 0 }).materialize({ projectId, generationId, environment: "dev", configurationFingerprint: fingerprint, secretValues: { EMAIL_PASS: secretValue } });
  assert.equal(emailMaterialization?.valueFromByName.EMAIL_PASS, `${secretArn}:EMAIL_PASS::`, "supplied optional password-like values use the existing ECS secret-reference path");

  const scheduled = new Port();
  scheduled.description = {
    arn: secretArn,
    name: `deployguard/${projectId}/production/application/runtime`,
    deletionDate: new Date(),
    tags: { ManagedBy: "DeployGuard", DeployGuardProjectId: projectId, DeployGuardScope: "project", Environment: "production", SecretPurpose: "application_runtime" },
    versions: {},
  };
  await new RuntimeSecretMaterializer(scheduled, { attempts: 2, intervalMs: 0 }).materialize({ projectId, generationId, environment: "production", configurationFingerprint: fingerprint, secretValues: { JWT_SECRET: secretValue } });
  assert.deepEqual({ restores: scheduled.restores, puts: scheduled.puts }, { restores: 1, puts: 1 });

  const mismatched = new Port();
  mismatched.description = { ...scheduled.description, deletionDate: null, tags: { ...scheduled.description.tags, DeployGuardProjectId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" } };
  await assert.rejects(new RuntimeSecretMaterializer(mismatched).materialize({ projectId, generationId, environment: "production", configurationFingerprint: fingerprint, secretValues: { JWT_SECRET: secretValue } }), /ownership verification/);

  const workflow = readFileSync(join(__dirname, "../../.github/workflows/deployguard-reusable.yml"), "utf8");
  const validationShell = workflow.match(/      - name: Validate immutable operation contract\n        shell: bash\n        run: \|\n([\s\S]*?)\n\n      - name: Derive immutable release identity/)?.[1];
  assert.ok(validationShell, "workflow validation shell must be present");
  assert.doesNotThrow(() => execFileSync("bash", ["-n", "-c", validationShell!.replace(/^          /gm, "")]), "runtime configuration validation shell must parse");
  const imageBuildShell = workflow.match(/      - name: Build and push immutable image\n        if: inputs\.deployment_action == 'deploy'\n        id: image\n        shell: bash\n        run: \|\n([\s\S]*?)\n\n      - name: Install Terraform/)?.[1];
  assert.ok(imageBuildShell, "workflow image-build shell must be present");
  assert.doesNotThrow(
    () => execFileSync("bash", ["-n", "-c", imageBuildShell!.replace(/^          /gm, "").replace(/\$\{\{[^}]+\}\}/g, "workflow_expression")]),
    "the exact workflow image-build shell, including BuildKit runtime-secret materialization, must parse",
  );
  const buildMaterializer = imageBuildShell!.match(/COMPONENT="\$component" BUILD_RUNTIME_CONFIG="\$BUILD_RUNTIME_CONFIG" node <<'NODE'\n([\s\S]*?)\n          NODE/)?.[1]?.replace(/^              /gm, "");
  assert.ok(buildMaterializer, "workflow must contain the generated-build runtime materializer");
  const materializerWorkspace = mkdtempSync(join(tmpdir(), "deployguard-build-init-contract-"));
  try {
    mkdirSync(join(materializerWorkspace, ".deployguard"), { recursive: true });
    const materializedRuntime = {
      ...configuration,
      environment: {
        APP_ENV: "production",
        DB_HOST: "database.runtime.internal",
        DB_PORT: "5432",
        DB_NAME: "runtime_database",
        DB_USER: "runtime_user",
      },
      secretReferences: {},
    };
    writeFileSync(join(materializerWorkspace, ".deployguard", "runtime-config.json"), JSON.stringify(materializedRuntime));
    const output = join(materializerWorkspace, "build-runtime.json");
    const component = {
      id: "application", role: "application", language: "python", framework: "django",
      buildCommand: "python manage.py collectstatic --noinput",
      buildInitialization: { contractVersion: "deployguard.build-initialization/v1", mode: "runtime_placeholders", reason: "fixture" },
      environmentOwnership: [
        { key: "APP_ENV", source: "application" },
        { key: "DB_HOST", source: "managed_database" }, { key: "DB_PORT", source: "managed_database" },
        { key: "DB_NAME", source: "managed_database" }, { key: "DB_USER", source: "managed_database" },
        { key: "DB_PASSWORD", source: "managed_database" },
      ],
    };
    execFileSync(process.execPath, ["-e", buildMaterializer!], {
      env: { ...process.env, GITHUB_WORKSPACE: materializerWorkspace, BUILD_RUNTIME_CONFIG: output, COMPONENT: JSON.stringify(component) },
    });
    const buildValues = JSON.parse(readFileSync(output, "utf8"));
    assert.equal(buildValues.APP_ENV, "production", "real component application configuration remains available only through the ephemeral build secret");
    assert.equal(buildValues.DB_HOST, "deployguard-build-init.invalid");
    assert.equal(buildValues.DB_PORT, "5432");
    assert.equal(buildValues.DB_NAME, "deployguard_build_init");
    assert.equal(buildValues.DB_USER, "deployguard_build_init");
    assert.equal(buildValues.DB_PASSWORD, "deployguard-build-init-placeholder");
    assert.doesNotMatch(JSON.stringify(buildValues), /database\.runtime\.internal|runtime_database|runtime_user/, "managed runtime database values must not be used while building the image");
  } finally {
    rmSync(materializerWorkspace, { recursive: true, force: true });
  }
  const runtimeJqStart = workflow.indexOf("            jq -e --arg operation", workflow.indexOf("      - name: Validate immutable operation contract"));
  const runtimeJqFilterStart = workflow.indexOf(" '\n", runtimeJqStart) + 3;
  const runtimeJqFilterEnd = workflow.indexOf("\n            ' .deployguard/runtime-config.json >/dev/null", runtimeJqFilterStart);
  assert.ok(runtimeJqStart >= 0 && runtimeJqFilterStart >= 3 && runtimeJqFilterEnd > runtimeJqFilterStart, "runtime configuration jq filter must be present");
  const runtimeJqFilter = workflow.slice(runtimeJqFilterStart, runtimeJqFilterEnd).replace(/^              /gm, "");
  const workflowRuntime = {
    ...configuration,
    environment: { ...configuration.environment, DEPLOYGUARD_OPERATION_ID: configuration.promotion.operationId },
  };
  const executeWorkflowRuntimeJq = (runtime: unknown) => execFileSync("jq", [
    "-e", "--arg", "operation", configuration.promotion.operationId,
    "--arg", "project", projectId,
    "--arg", "environment", "dev",
    "--arg", "generation", generationId,
    "--arg", "mongodbHealthCheck", Buffer.from("bW9uZ29zaCAtLXF1aWV0IC0tdXNlcm5hbWUgIiRNT05HT19JTklUREJfUk9PVF9VU0VSTkFNRSIgLS1wYXNzd29yZCAiJE1PTkdPX0lOSVREQl9ST09UX1BBU1NXT1JEIiAtLWF1dGhlbnRpY2F0aW9uRGF0YWJhc2UgYWRtaW4gLS1ldmFsICdkYi5hZG1pbkNvbW1hbmQoeyBwaW5nOiAxIH0pJyA+L2Rldi9udWxs", "base64").toString("utf8"),
    runtimeJqFilter,
  ], {
    input: JSON.stringify(runtime),
    env: { ...process.env, DEPLOYMENT_ACTION: "deploy" },
  }).toString("utf8").trim();
  assert.equal(executeWorkflowRuntimeJq(workflowRuntime), "true", "the exact workflow jq filter accepts a valid deploy runtime configuration");
  for (const required of [
    /component_runtime\s+=\s+try\(local\.runtime_config\.componentRuntime, \{\}\)/,
    /local\.component_runtime\[component\.id\]\.environment/,
    /local\.component_runtime\[component\.id\]\.secretReferences/,
    /component\.id == try\(local\.managed_database\.ownerComponentId, ""\)/,
    /project_persistence_outputs\.database_url_secret_arn/,
    /project_persistence_outputs\.database_password_secret_arn/,
    /Action = \["secretsmanager:GetSecretValue"\]/,
    /Resource = concat\([\s\S]*local\.application_secret_arns/,
    /pg_isready -U \$POSTGRES_USER -d \$POSTGRES_DB/,
    /--arg mongodbHealthCheck "\$MONGODB_HEALTH_CHECK"/,
    /depends_on = \[aws_lb_listener_rule\.candidate/,
    /configurationSnapshotId:\$configurationSnapshotId/,
    /secretReferenceNames:\$secretReferenceNames/,
    /retentionProtectedRelease\.imageDigests/,
    /retentionProtectedRelease\.taskDefinitionArns/,
  ]) assert.match(workflow, required);
  assert.doesNotMatch(workflow, /SecretString\s*=\s*\$\{\{/);
  const deployment = readFileSync(join(__dirname, "../src/projects/github-actions-deployment.service.ts"), "utf8");
  const stableReleaseProjection = readFileSync(join(__dirname, "../src/projects/stable-release-projection.ts"), "utf8");
  for (const required of [
    /createRunConfigurationSnapshot\(projectId, operationId, environmentName/,
    /runtimeSecrets\.materialize/,
    /immutableDispatchInputs: inputs/,
    /verifyAndPersistStableRelease/,
    /validateGithubActionsRuntimeEvidence\(evidence/,
    /configurationSnapshotId: runtime\.configurationSnapshotId/,
    /managedDatabaseBinding: runtime\.managedDatabase/,
    /secretReferences: Object\.entries\(runtime\.secretReferences\)/,
    /runtimeConfigurationWithPromotionCandidate\(runtime, candidate\)/,
    /error instanceof GithubActionsOperationContractError && error\.code === "invalid_contract"/,
    /return this\.failCandidateOperation\(/,
  ]) assert.match(deployment, required);
  assert.match(stableReleaseProjection, /deployedByPipelineRunId: input\.operationId/);
  assert.doesNotMatch(deployment, /remoteCommit\s*!==\s*expectedCommit/, "the managed caller commit is not the immutable application commit");
  assert.doesNotMatch(deployment, /metadata:[\s\S]{0,200}projectSecretValues/);

  const release = extractGithubActionsReleaseEvidence(`DEPLOYGUARD_RELEASE_RESULT=${JSON.stringify({
    contractVersion: "deployguard.deployment-result/v2",
    deploymentOperationId: "01234567-89ab-4cde-8fab-0123456789ab",
    generationId,
    environmentName: "dev",
    commitSha: "a".repeat(40),
    imageUri: "563149050793.dkr.ecr.us-east-1.amazonaws.com/deployguard-app@sha256:" + "a".repeat(64),
    imageDigest: "sha256:" + "a".repeat(64),
    taskDefinitionArn: "arn:aws:ecs:us-east-1:563149050793:task-definition/dg-app:3",
    clusterName: "dg-app", serviceName: "dg-app",
    ecsServiceArn: "arn:aws:ecs:us-east-1:563149050793:service/dg-shared/dg-app",
    targetGroupArn: "arn:aws:elasticloadbalancing:us-east-1:563149050793:targetgroup/dg-app/1234567890abcdef",
    listenerRuleArn: "arn:aws:elasticloadbalancing:us-east-1:563149050793:listener-rule/app/dg-shared/1234567890abcdef/1234567890abcdef/1234567890abcdef",
    routingVerified: true,
    candidateRouteRemoved: true,
    promotionIntentFingerprint: "3".repeat(64),
    appPort: 3000, healthCheckPath: "/health",
    configurationFingerprint: fingerprint, configurationSnapshotId: snapshotId, databaseBindingId: bindingId,
    secretReferenceNames: ["JWT_SECRET"], databaseOutputs: { database_password_secret_arn: secretArn },
  })}`);
  assert.equal(release?.configurationSnapshotId, snapshotId);
  assert.equal(release?.commitSha, "a".repeat(40));
  assert.deepEqual(release?.secretReferenceNames, ["JWT_SECRET"]);
  assert.doesNotMatch(JSON.stringify(release), new RegExp(secretValue));

  console.log("Iteration 11 runtime configuration checks passed: immutable non-secret rendering, ECS valueFrom references, managed PostgreSQL aliases, idempotent secret materialization, ownership fail-closed behavior and sanitized stable-release evidence.");
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Runtime configuration verification failed.");
  process.exitCode = 1;
});
