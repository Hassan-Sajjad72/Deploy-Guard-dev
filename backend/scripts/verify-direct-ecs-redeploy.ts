import "reflect-metadata";
import { strict as assert } from "node:assert";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { RailpackDeploymentService } from "../src/projects/railpack-deployment.service";
import { RailpackRuntimeConfiguration } from "../src/projects/railpack-workflow-contract";
import { DatabaseTierStatus } from "../src/projects/project-database-tier.entity";

const projectId = "11111111-1111-4111-8111-111111111111";
const operationId = "22222222-2222-4222-8222-222222222222";
const serviceId = "33333333-3333-4333-8333-333333333333";
const runtimeRevisionId = "44444444-4444-4444-8444-444444444444";
const image = `123456789012.dkr.ecr.us-east-1.amazonaws.com/deployguard-test@sha256:${"a".repeat(64)}`;
const aliases = ["MYSQL_HOST", "MYSQL_PORT", "MYSQL_USER", "MYSQL_DATABASE", "MYSQL_PASSWORD", "MYSQL_URL"];
const repositoryRoot = join(__dirname, "..", "..");
const workflow = readFileSync(join(repositoryRoot, ".github", "workflows", "deployguard-reusable.yml"), "utf8");
const terraform = readFileSync(join(repositoryRoot, "infrastructure", "railpack-runtime", "main.tf"), "utf8");
const directWorkflow = workflow.match(/elif \[ "\$RELEASE_ONLY" = true \]; then([\s\S]*?)\n          else/)?.[1] || "";
assert.ok(directWorkflow, "the release-only branch must be independently extractable");
assert.match(directWorkflow, /terraform -chdir=\.deployguard\/terraform output -json[\s\S]*?register-release-task-definitions\.sh[\s\S]*?verify-runtime\.sh[\s\S]*?build-release-result\.sh/);
assert.doesNotMatch(directWorkflow, /terraform -chdir=.*\b(plan|apply)\b/, "release-only deployment must not re-run Terraform plan or apply");
assert.match(terraform, /resource "aws_ecs_service" "application"[\s\S]*?ignore_changes\s+=\s+\[desired_count, task_definition\]/, "Terraform must preserve direct ECS active task definitions while still owning the service resource");
const runtime: RailpackRuntimeConfiguration = {
  schemaVersion: 3, projectId, operationId, environmentName: "dev", sourceSha: "b".repeat(40), services: [{
    serviceId, serviceName: "API", serviceDirectory: "backend", servicePort: 8000, runtimeConfigRevisionId: runtimeRevisionId,
    buildEnvironment: {}, buildSecretReferences: {}, environment: { PORT: "8000", HOST: "0.0.0.0", RELEASE: "candidate" },
    secretReferences: { TOKEN: `arn:aws:secretsmanager:us-east-1:123456789012:secret:deployguard/test:TOKEN::${"c".repeat(64)}` },
    databaseAttached: true, managedDatabase: { engine: "mysql", aliases },
  }],
};
const outputs = {
  ecs_cluster_name: "dg-cluster",
  services: { [serviceId]: {
    ecs_service_name: "dg-api", transport_probe_port: 65535, image: "old-image", runtime_config_revision_id: "old-revision", task_definition_arn: "arn:aws:ecs:us-east-1:123456789012:task-definition/dg-api:7", service_port: 8000,
  } },
  database: { host: "database.dg.internal", port: 3306, credentials_secret_arn: "arn:aws:secretsmanager:us-east-1:123456789012:secret:deployguard/database", secret_version_id: "terraform-20260901000000000000000001" },
};
const artifacts = [{ serviceId, servicePort: 8000, runtimeConfigRevisionId: runtimeRevisionId, image }];
const baseTask = {
  taskDefinition: {
    family: "dg-api", taskRoleArn: "arn:aws:iam::123456789012:role/task", executionRoleArn: "arn:aws:iam::123456789012:role/execution", networkMode: "awsvpc", requiresCompatibilities: ["FARGATE"], cpu: "512", memory: "1024",
    containerDefinitions: [
      { name: "application", image: "old-image", portMappings: [{ containerPort: 8000, hostPort: 8000, protocol: "tcp" }], environment: [], secrets: [], logConfiguration: { logDriver: "awslogs", options: { "awslogs-group": "/deployguard/test" } } },
      { name: "deployguard-transport-probe", image: "public.ecr.aws/docker/library/busybox:1.36.1@sha256:73aaf090f3d85aa34ee199857f03fa3a95c8ede2ffd4cc2cdb5b94e566b11662", essential: true, portMappings: [{ containerPort: 65535, hostPort: 65535, protocol: "tcp" }], environment: [{ name: "APPLICATION_PORT", value: "8000" }, { name: "PROBE_PORT", value: "65535" }] },
    ],
  }, tags: [{ key: "ManagedBy", value: "DeployGuard" }],
};

function runScript(desiredCount = 1) {
  const directory = mkdtempSync(join(tmpdir(), "deployguard-release-only-"));
  const bin = join(directory, "bin");
  mkdirSync(bin);
  const fakeAws = join(bin, "aws");
  const outputsPath = join(directory, "outputs.json"); const runtimePath = join(directory, "runtime.json"); const artifactsPath = join(directory, "artifacts.json");
  writeFileSync(outputsPath, JSON.stringify(outputs)); writeFileSync(runtimePath, JSON.stringify(runtime)); writeFileSync(artifactsPath, JSON.stringify(artifacts));
  writeFileSync(fakeAws, `#!/usr/bin/env bash
set -euo pipefail
if [ "$1 $2" = "ecs describe-services" ]; then printf '%s\\n' '${JSON.stringify({ services: [{ taskDefinition: "arn:aws:ecs:us-east-1:123456789012:task-definition/dg-api:7", desiredCount }] })}'; exit 0; fi
if [ "$1 $2" = "ecs describe-task-definition" ]; then printf '%s\\n' '${JSON.stringify(baseTask)}'; exit 0; fi
if [ "$1 $2" = "ecs register-task-definition" ]; then
  for value in "$@"; do case "$value" in file://*) input="\${value#file://}";; esac; done
  jq -e --arg image '${image}' '([.containerDefinitions[] | select(.name == "application")][0]) as $app | $app.image == $image and ([$app.environment[] | .name] | index("MYSQL_DATABASE")) != null and ([$app.secrets[] | .name] | index("MYSQL_PASSWORD")) != null and ([.tags[] | select(.key == "DeployGuardRuntimeConfigRevisionId" and .value == "${runtimeRevisionId}")] | length == 1)' "$input" >/dev/null
  printf '%s\\n' '{"taskDefinition":{"taskDefinitionArn":"arn:aws:ecs:us-east-1:123456789012:task-definition/dg-api:8"}}'; exit 0
fi
if [ "$1 $2" = "ecs update-service" ]; then printf '%s\\n' "$*" >> "\${FAKE_AWS_LOG}"; printf '%s\\n' '{}'; exit 0; fi
exit 91
`);
  chmodSync(fakeAws, 0o755);
  const script = join(__dirname, "..", "..", "infrastructure", "railpack-runtime", "register-release-task-definitions.sh");
  const result = spawnSync("bash", [script, outputsPath, runtimePath, artifactsPath], { encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_AWS_LOG: join(directory, "aws.log") } });
  return { directory, result };
}

const successful = runScript();
assert.equal(successful.result.status, 0, successful.result.stderr);
const releaseOutputs = JSON.parse(successful.result.stdout);
assert.equal(releaseOutputs.services[serviceId].image, image, "release evidence must retain the immutable image digest");
assert.equal(releaseOutputs.services[serviceId].runtime_config_revision_id, runtimeRevisionId, "release evidence must retain the new immutable runtime revision");
assert.equal(releaseOutputs.services[serviceId].task_definition_arn, "arn:aws:ecs:us-east-1:123456789012:task-definition/dg-api:8", "release evidence must use the ECS-registered revision");
assert.match(readFileSync(join(successful.directory, "aws.log"), "utf8"), /--task-definition arn:aws:ecs:us-east-1:123456789012:task-definition\/dg-api:8 --force-new-deployment/, "ECS must receive the registered revision directly");
rmSync(successful.directory, { recursive: true, force: true });

const inactive = runScript(0);
assert.notEqual(inactive.result.status, 0, "an inactive/unbootstrapped service must fall back instead of receiving a direct release");
assert.match(inactive.result.stderr, /inactive_service_requires_terraform/);
rmSync(inactive.directory, { recursive: true, force: true });

void (async () => {
const candidate = Object.create(RailpackDeploymentService.prototype) as any;
const liveRevision = { serviceId, serviceName: "API", serviceDirectory: "backend", runtimeConfigRevisionId: "55555555-5555-4555-8555-555555555555", runtimeIdentity: { servicePort: 8000 } };
candidate.dataSource = { getRepository: () => ({ findOne: async () => ({ liveGenerationId: "66666666-6666-4666-8666-666666666666" }) }) };
candidate.serviceRevisions = { find: async () => [liveRevision] };
candidate.runtimeConfigRevisions = { find: async () => [{ id: liveRevision.runtimeConfigRevisionId, databaseConfiguration: { attached: true, engine: "mysql", aliases } }] };
const configuration: any = { managedDatabase: { status: DatabaseTierStatus.READY, activeGenerationId: "66666666-6666-4666-8666-666666666666", attachedServiceId: serviceId, engine: "mysql" } };
assert.equal(await candidate.releaseOnlyRedeployEligible(projectId, "dev", configuration, runtime), true, "same live topology is eligible for direct ECS release");
const changedPort: any = structuredClone(runtime); changedPort.services[0].servicePort = 9000; changedPort.services[0].environment.PORT = "9000";
assert.equal(await candidate.releaseOnlyRedeployEligible(projectId, "dev", configuration, changedPort), false, "a port/topology change must retain Terraform fallback");
const staleDatabase: any = { ...configuration, managedDatabase: { ...configuration.managedDatabase, activeGenerationId: "77777777-7777-4777-8777-777777777777" } };
assert.equal(await candidate.releaseOnlyRedeployEligible(projectId, "dev", staleDatabase, runtime), false, "a database not owned by the live generation must retain Terraform fallback");

console.log("DIRECT_ECS_REDEPLOY=PASS REGISTER_UPDATE_VERIFY_EVIDENCE=1 TOPOLOGY_FALLBACK=1 ACTIVE_TASK_DEFINITION_GATE=1 DATABASE_GENERATION_GATE=1");
})().catch((error) => { console.error(error); process.exitCode = 1; });
