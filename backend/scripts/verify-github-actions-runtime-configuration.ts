import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
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

async function main() {
  const encoded = environmentReferencesBase64(configuration);
  const decoded = decodeEnvironmentReferencesBase64(encoded);
  assert.deepEqual(decoded, decodeEnvironmentReferencesBase64(environmentReferencesBase64({ ...configuration, environment: Object.fromEntries(Object.entries(configuration.environment).reverse()) })));
  assert.equal(decoded.environment.JWT_EXPIRES_IN, "1h");
  assert.equal(decoded.secretReferences.JWT_SECRET, `${secretArn}:JWT_SECRET::`);
  assert.deepEqual(decoded.managedDatabase?.secretAliases, { DATABASE_URL: "url", DB_PASSWORD: "password" });
  assert.deepEqual(decoded.retentionProtectedRelease, configuration.retentionProtectedRelease);
  assert.doesNotMatch(encoded, new RegExp(secretValue));
  assert.throws(() => decodeEnvironmentReferencesBase64(Buffer.from(JSON.stringify({ ...configuration, secretReferences: { JWT_SECRET: secretValue } })).toString("base64")), /invalid/i);

  const candidate: GithubActionsCandidateEvidence = {
    contractVersion: "deployguard.candidate-result/v1",
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
  for (const required of [
    /environment\s+=\s+local\.app_environment/,
    /secrets\s+=\s+concat\(local\.app_project_secrets, local\.app_database_secrets\)/,
    /valueFrom\s+=\s+local\.runtime_config\.secretReferences\[key\]/,
    /managed_database\.secretAliases\[key\] == "url"/,
    /project_persistence_outputs\.database_password_secret_arn/,
    /Action = \["secretsmanager:GetSecretValue"\]/,
    /Resource = concat\([\s\S]*local\.application_secret_arns/,
    /pg_isready -U \$POSTGRES_USER -d \$POSTGRES_DB/,
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
