import "reflect-metadata";
import { strict as assert } from "node:assert";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { RailpackDeploymentService } from "../src/projects/railpack-deployment.service";
import { RailpackRuntimeConfiguration } from "../src/projects/railpack-workflow-contract";
import { ProjectEnvironmentRoute } from "../src/projects/project-environment-route.entity";
import { DatabaseTierStatus, ProjectDatabaseTier } from "../src/projects/project-database-tier.entity";

const projectId = "11111111-1111-4111-8111-111111111111";
const serviceId = "33333333-3333-4333-8333-333333333333";
const revisionId = "44444444-4444-4444-8444-444444444444";
const currentRevisionId = "55555555-5555-4555-8555-555555555555";
const liveGenerationId = "66666666-6666-4666-8666-666666666666";
const image = `123456789012.dkr.ecr.us-east-1.amazonaws.com/deployguard-test@sha256:${"a".repeat(64)}`;
const historicalTaskDefinition = "arn:aws:ecs:us-east-1:123456789012:task-definition/dg-api:3";
const currentTaskDefinition = "arn:aws:ecs:us-east-1:123456789012:task-definition/dg-api:9";
const databaseSecretVersion = "terraform-20260901000000000000000001";
const aliases = ["MYSQL_HOST", "MYSQL_PORT", "MYSQL_USER", "MYSQL_DATABASE", "MYSQL_PASSWORD", "MYSQL_URL"];
const repositoryRoot = join(__dirname, "..", "..");
const workflow = readFileSync(join(repositoryRoot, ".github", "workflows", "deployguard-reusable.yml"), "utf8");
const directWorkflow = workflow.match(/elif \[ "\$RELEASE_ONLY" = true \]; then([\s\S]*?)\n          else/)?.[1] || "";
assert.match(workflow, /release_only_requires_deploy_or_rollback/);
assert.match(directWorkflow, /register-release-task-definitions\.sh[^\n]*"\$DEPLOYMENT_ACTION"/);
assert.doesNotMatch(directWorkflow, /terraform -chdir=.*\b(plan|apply)\b/, "direct rollback must retain Terraform topology ownership");

const runtime: RailpackRuntimeConfiguration = {
  schemaVersion: 3, projectId, operationId: "22222222-2222-4222-8222-222222222222", environmentName: "dev", sourceSha: "b".repeat(40), services: [{
    serviceId, serviceName: "API", serviceDirectory: "backend", servicePort: 8000, runtimeConfigRevisionId: revisionId,
    buildEnvironment: {}, buildSecretReferences: {}, environment: { PORT: "8000", HOST: "0.0.0.0", RELEASE: "historical" }, secretReferences: {},
    databaseAttached: true, managedDatabase: { engine: "mysql", aliases, secretVersionId: databaseSecretVersion }, rollbackImage: image, rollbackTaskDefinitionArn: historicalTaskDefinition,
  }],
};
const outputs = {
  ecs_cluster_name: "dg-cluster",
  services: { [serviceId]: { ecs_service_name: "dg-api", transport_probe_port: 65535, image: "current-image", runtime_config_revision_id: currentRevisionId, task_definition_arn: currentTaskDefinition, service_port: 8000 } },
  database: { host: "database.dg.internal", port: 3306, credentials_secret_arn: "arn:aws:secretsmanager:us-east-1:123456789012:secret:deployguard/database", secret_version_id: databaseSecretVersion },
};
const artifacts = [{ serviceId, servicePort: 8000, runtimeConfigRevisionId: revisionId, image }];
const probe = { name: "deployguard-transport-probe", image: "public.ecr.aws/docker/library/busybox:1.36.1@sha256:73aaf090f3d85aa34ee199857f03fa3a95c8ede2ffd4cc2cdb5b94e566b11662", portMappings: [{ containerPort: 65535, hostPort: 65535 }], environment: [{ name: "APPLICATION_PORT", value: "8000" }, { name: "PROBE_PORT", value: "65535" }] };
const targetTask = { taskDefinition: { family: "dg-api", containerDefinitions: [
  { name: "application", image, portMappings: [{ containerPort: 8000, hostPort: 8000 }], environment: [{ name: "PORT", value: "8000" }, { name: "HOST", value: "0.0.0.0" }, { name: "RELEASE", value: "historical" }, { name: "MYSQL_HOST", value: "database.dg.internal" }, { name: "MYSQL_PORT", value: "3306" }, { name: "MYSQL_USER", value: "deployguard" }, { name: "MYSQL_DATABASE", value: "application" }], secrets: [{ name: "MYSQL_PASSWORD", valueFrom: `arn:aws:secretsmanager:us-east-1:123456789012:secret:deployguard/database:password::${databaseSecretVersion}` }, { name: "MYSQL_URL", valueFrom: `arn:aws:secretsmanager:us-east-1:123456789012:secret:deployguard/database:url::${databaseSecretVersion}` }] }, probe,
] } };
const currentTask = { taskDefinition: { family: "dg-api", containerDefinitions: [{ name: "application", image: "current-image", portMappings: [{ containerPort: 8000, hostPort: 8000 }] }, probe] } };

function runScript(candidateRuntime: RailpackRuntimeConfiguration = runtime) {
  const directory = mkdtempSync(join(tmpdir(), "deployguard-direct-rollback-"));
  const bin = join(directory, "bin"); mkdirSync(bin);
  const log = join(directory, "aws.log"); const aws = join(bin, "aws");
  const outputsPath = join(directory, "outputs.json"); const runtimePath = join(directory, "runtime.json"); const artifactsPath = join(directory, "artifacts.json");
  writeFileSync(outputsPath, JSON.stringify(outputs)); writeFileSync(runtimePath, JSON.stringify(candidateRuntime)); writeFileSync(artifactsPath, JSON.stringify(artifacts));
  writeFileSync(aws, `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "${log}"
if [ "$1 $2" = "ecs describe-services" ]; then printf '%s\\n' '${JSON.stringify({ services: [{ taskDefinition: currentTaskDefinition, desiredCount: 1 }] })}'; exit 0; fi
if [ "$1 $2" = "ecs describe-task-definition" ]; then
  for value in "$@"; do [ "$value" = "${historicalTaskDefinition}" ] && { printf '%s\\n' '${JSON.stringify(targetTask)}'; exit 0; }; done
  printf '%s\\n' '${JSON.stringify(currentTask)}'; exit 0
fi
if [ "$1 $2" = "ecs register-task-definition" ]; then exit 97; fi
if [ "$1 $2" = "ecs update-service" ]; then printf '%s\\n' '{}'; exit 0; fi
exit 91
`);
  chmodSync(aws, 0o755);
  const script = join(repositoryRoot, "infrastructure", "railpack-runtime", "register-release-task-definitions.sh");
  const result = spawnSync("bash", [script, outputsPath, runtimePath, artifactsPath, "rollback"], { cwd: directory, encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
  return { directory, result, log };
}

const success = runScript();
assert.equal(success.result.status, 0, success.result.stderr);
const rollbackOutputs = JSON.parse(success.result.stdout);
assert.equal(rollbackOutputs.services[serviceId].task_definition_arn, historicalTaskDefinition, "rollback must update ECS to the exact persisted task-definition revision");
const calls = readFileSync(success.log, "utf8");
assert.match(calls, new RegExp(`ecs update-service .*--task-definition ${historicalTaskDefinition} --force-new-deployment`));
assert.doesNotMatch(calls, /ecs register-task-definition/, "rollback must not synthesize a replacement historical revision");
rmSync(success.directory, { recursive: true, force: true });

const staleSecret: RailpackRuntimeConfiguration = structuredClone(runtime);
staleSecret.services[0].managedDatabase.secretVersionId = "different-20260901000000000000000001";
const mismatch = runScript(staleSecret);
assert.notEqual(mismatch.result.status, 0);
assert.match(mismatch.result.stderr, /rollback_database_secret_version_mismatch/);
assert.doesNotMatch(readFileSync(mismatch.log, "utf8"), /ecs update-service/);
rmSync(mismatch.directory, { recursive: true, force: true });

void (async () => {
  const target: any = { releaseId: "release", targetOperationId: "operation", generationId: "target-generation", sourceSha: runtime.sourceSha, services: [{ serviceId, serviceName: "API", serviceDirectory: "backend", imageUri: image.split("@")[0], imageDigest: image.split("@")[1], immutableImage: image, taskDefinitionArn: historicalTaskDefinition, runtimeConfigRevisionId: revisionId, runtimeConfiguration: { servicePort: 8000, environment: runtime.services[0].environment, secretReferences: {}, databaseAttached: true, managedDatabase: runtime.services[0].managedDatabase } }] };
  const current = { serviceId, serviceName: "API", serviceDirectory: "backend", runtimeConfigRevisionId: currentRevisionId, runtimeIdentity: { servicePort: 8000 } };
  const tier = { status: DatabaseTierStatus.READY, activeGenerationId: liveGenerationId, attachedServiceId: serviceId, engine: "mysql" };
  const candidate = Object.create(RailpackDeploymentService.prototype) as any;
  candidate.dataSource = { getRepository: (entity: unknown) => ({ findOne: async () => entity === ProjectEnvironmentRoute ? { liveGenerationId } : entity === ProjectDatabaseTier ? tier : null }) };
  candidate.serviceRevisions = { find: async () => [current] };
  candidate.runtimeConfigRevisions = { find: async () => [{ id: currentRevisionId, databaseConfiguration: { attached: true, engine: "mysql", aliases, secretVersionId: databaseSecretVersion } }] };
  assert.equal(await candidate.directEcsRollbackEligible(projectId, "dev", target, runtime), true, "sealed target and compatible LIVE topology may use direct ECS rollback");
  const incompatible = structuredClone(runtime); incompatible.services[0].managedDatabase.secretVersionId = "different-20260901000000000000000001";
  assert.equal(await candidate.directEcsRollbackEligible(projectId, "dev", target, incompatible), false, "database secret-version drift retains Terraform rollback fallback");
  const legacyTarget = structuredClone(target); delete legacyTarget.services[0].taskDefinitionArn;
  const legacyRuntime = structuredClone(runtime); delete legacyRuntime.services[0].rollbackTaskDefinitionArn;
  assert.equal(await candidate.directEcsRollbackEligible(projectId, "dev", legacyTarget, legacyRuntime), false, "legacy rollback evidence without an ECS revision retains Terraform fallback");
  console.log("DIRECT_ECS_ROLLBACK=PASS EXACT_TASK_DEFINITION=1 NO_REGISTRATION=1 DATABASE_SECRET_BOUNDARY=1 TERRAFORM_FALLBACK=1");
})().catch((error) => { console.error(error); process.exitCode = 1; });
