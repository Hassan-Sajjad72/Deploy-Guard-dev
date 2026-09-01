import "reflect-metadata";
import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { RailpackDeploymentService, promotedServiceRevisions } from "../src/projects/railpack-deployment.service";
import { servicesBase64, RailpackRuntimeConfiguration } from "../src/projects/railpack-workflow-contract";
import { resolveProjectApplicationUrl } from "../src/projects/application-entrypoint";

const projectId = "11111111-1111-4111-8111-111111111111";
const operationId = "22222222-2222-4222-8222-222222222222";
const ids = ["33333333-3333-4333-8333-333333333333", "44444444-4444-4444-8444-444444444444"];
const sourceSha = "a".repeat(40);
const runtime: RailpackRuntimeConfiguration = { schemaVersion: 2, projectId, operationId, environmentName: "dev", sourceSha, services: ids.map((serviceId, index) => ({ serviceId, runtimeConfigRevisionId: `${index ? "66666666-6666-4666-8666-666666666666" : "55555555-5555-4555-8555-555555555555"}`, serviceName: index ? "API" : "Web", serviceDirectory: index ? "api" : "web", buildEnvironment: {}, buildSecretReferences: {}, environment: { PORT: "8080", HOST: "0.0.0.0", RELEASE: index ? "api" : "web" }, secretReferences: { TOKEN: `arn:aws:secretsmanager:us-east-1:123456789012:secret:deployguard/${serviceId}:TOKEN::${index ? "b".repeat(64) : "a".repeat(64)}` }, databaseAttached: index === 1, managedDatabase: index === 1 ? { engine: "postgres", aliases: ["DATABASE_URL"] } : { engine: null, aliases: [] } })) };
const service = Object.create(RailpackDeploymentService.prototype) as any;
const operation: any = { id: operationId, commitSha: sourceSha, metadata: { deploymentAction: "deploy", immutableDispatchInputs: { services_base64: servicesBase64(runtime) } } };
const serviceEvidence = runtime.services.map((expected, index) => {
  const imageUri = `123456789012.dkr.ecr.us-east-1.amazonaws.com/dg-${index}`;
  const imageDigest = `sha256:${String(index + 1).repeat(64)}`;
  return { ...expected, environment: undefined, secretReferences: undefined, databaseAttached: undefined, managedDatabase: undefined, imageUri, imageDigest, image: `${imageUri}@${imageDigest}` };
});
const terraformServices = Object.fromEntries(serviceEvidence.map((item, index) => [item.serviceId, { image: item.image, runtime_config_revision_id: item.runtimeConfigRevisionId, public_url: `http://service-${index}.example.test`, task_definition_arn: `arn:aws:ecs:us-east-1:123456789012:task-definition/dg-${index}:1`, ecs_service_arn: `arn:aws:ecs:us-east-1:123456789012:service/dg/dg-${index}`, ecs_service_name: `dg-${index}`, alb_arn: `arn:aws:elasticloadbalancing:us-east-1:123456789012:loadbalancer/app/dg/${index}`, alb_name: `dg-${index}`, alb_target_group_arn: `arn:aws:elasticloadbalancing:us-east-1:123456789012:targetgroup/dg/${index}`, alb_target_group_name: `dg-${index}`, cloudwatch_log_group_name: `/deployguard/${projectId}/services/${item.serviceId}`, application_container_name: "application" }]));
const database = { attached_service_id: ids[1], engine: "postgres", host: "database.internal", port: 5432, ecs_service_arn: "arn:aws:ecs:us-east-1:123456789012:service/dg/database", ecs_service_name: "database", task_definition_arn: "arn:aws:ecs:us-east-1:123456789012:task-definition/database:1", cloudwatch_log_group_name: `/deployguard/${projectId}/database`, credentials_secret_arn: "arn:aws:secretsmanager:us-east-1:123456789012:secret:deployguard/database", secret_version_id: "terraform-20260901000000000000000001" };
const runtimeOutcomes = runtime.services.map((expected, index) => ({
  serviceId: expected.serviceId,
  verified: true,
  image: terraformServices[expected.serviceId].image,
  ecsServiceArn: terraformServices[expected.serviceId].ecs_service_arn,
  taskDefinitionArn: terraformServices[expected.serviceId].task_definition_arn,
  runningTaskArns: [`arn:aws:ecs:us-east-1:123456789012:task/dg/${index + 1}`],
  ecsTasksRunning: 1,
  runtimePort: 8080,
  targetGroupArn: terraformServices[expected.serviceId].alb_target_group_arn,
  targetHealth: ["healthy"],
  environment: expected.environment,
  secretValueFrom: {
    ...expected.secretReferences,
    ...(expected.databaseAttached ? { DATABASE_URL: `${database.credentials_secret_arn}:url::${database.secret_version_id}` } : {}),
  },
  managedDatabase: expected.databaseAttached
    ? { attached: true, attachedServiceId: ids[1], engine: "postgres", aliases: ["DATABASE_URL"], credentialsSecretArn: database.credentials_secret_arn, secretVersionId: database.secret_version_id }
    : { attached: false, attachedServiceId: null, engine: null, aliases: [], credentialsSecretArn: null, secretVersionId: null },
  publicUrl: terraformServices[expected.serviceId].public_url,
  publicEndpointVerified: true,
  taskDefinition: true,
  secretsInjection: true,
  vpcConnectivity: true,
  publicReachability: true,
  checkedAt: "2026-09-01T00:00:00Z",
}));
const terraform = { aws_region: "us-east-1", ecs_cluster_arn: "arn:aws:ecs:us-east-1:123456789012:cluster/dg", ecs_cluster_name: "dg", services: terraformServices, database };
const awsRuntimeVerification = { contractVersion: "deployguard.aws-runtime-verification/v1", verified: true, verifiedAt: "2026-09-01T00:00:00Z", services: runtimeOutcomes, databaseVerified: true };
const artifact: any = { contractVersion: "deployguard.release-result/v4", action: "deploy", sourceSha, operationId, services: serviceEvidence, terraform, awsRuntimeVerification };

const handoffDirectory = mkdtempSync(join(tmpdir(), "deployguard-release-evidence-handoff-"));
const artifactsPath = join(handoffDirectory, "service-artifacts.json");
const terraformPath = join(handoffDirectory, "terraform-outputs.json");
const evidencePath = join(handoffDirectory, "aws-runtime-evidence.json");
const resultPath = join(handoffDirectory, "deployguard-result.json");
writeFileSync(artifactsPath, JSON.stringify(serviceEvidence), "utf8");
writeFileSync(terraformPath, JSON.stringify(terraform), "utf8");
writeFileSync(evidencePath, JSON.stringify(awsRuntimeVerification), "utf8");
const producer = join(__dirname, "..", "..", "infrastructure", "railpack-runtime", "build-release-result.sh");
const produced = spawnSync("bash", [producer, "deploy", "deployguard.release-result/v4", sourceSha, operationId, artifactsPath, terraformPath, evidencePath, resultPath], { encoding: "utf8" });
assert.equal(produced.status, 0, produced.stderr);
const terminalArtifact = JSON.parse(readFileSync(resultPath, "utf8"));
const handoff = service.validatedReleaseEvidence(operation, terminalArtifact);
assert.equal(terminalArtifact.sourceSha, sourceSha);
assert.deepEqual(handoff.serviceOutcomes, runtimeOutcomes, "the backend parser must consume the exact per-service AWS evidence emitted by the producer");
for (const [index, outcome] of handoff.serviceOutcomes.entries()) {
  assert.equal(outcome.serviceId, ids[index]);
  assert.equal(outcome.image, terraformServices[ids[index]].image);
  assert.equal(outcome.taskDefinitionArn, terraformServices[ids[index]].task_definition_arn);
  assert.equal(outcome.ecsServiceArn, terraformServices[ids[index]].ecs_service_arn);
  assert.equal(outcome.ecsTasksRunning, 1);
  assert.equal(outcome.runtimePort, 8080);
  assert.deepEqual(outcome.targetHealth, ["healthy"]);
  assert.deepEqual(outcome.environment, runtime.services[index].environment);
  assert.deepEqual(outcome.secretValueFrom.TOKEN, runtime.services[index].secretReferences.TOKEN);
  assert.equal(outcome.publicUrl, terraformServices[ids[index]].public_url);
}
assert.equal(handoff.serviceOutcomes[1].managedDatabase.secretVersionId, database.secret_version_id);
assert.equal(handoff.serviceOutcomes[1].secretValueFrom.DATABASE_URL, `${database.credentials_secret_arn}:url::${database.secret_version_id}`);
assert.equal(resolveProjectApplicationUrl(ids[0], handoff.services), terraformServices[ids[0]].public_url, "the configured application entrypoint retains its verified public endpoint");

writeFileSync(evidencePath, JSON.stringify({ ...awsRuntimeVerification, services: [] }), "utf8");
const rejected = spawnSync("bash", [producer, "deploy", "deployguard.release-result/v4", sourceSha, operationId, artifactsPath, terraformPath, evidencePath, join(handoffDirectory, "invalid-result.json")], { encoding: "utf8" });
assert.notEqual(rejected.status, 0, "the workflow producer must fail before upload when terminal AWS evidence is incomplete");
assert.match(rejected.stderr, /DG_WORKFLOW_CONTRACT_INVALID stage=release_evidence_validation/);
rmSync(handoffDirectory, { recursive: true, force: true });

const valid = service.validatedReleaseEvidence(operation, artifact);
assert.equal(valid.services.length, 2);
assert.deepEqual(valid.services.map((item: any) => item.serviceId), ids);
for (const invalid of [
  { ...artifact, services: artifact.services.slice(0, 1) },
  { ...artifact, services: [artifact.services[0], artifact.services[0]] },
  { ...artifact, terraform: { ...artifact.terraform, services: { [ids[0]]: terraformServices[ids[0]] } } },
  { ...artifact, awsRuntimeVerification: { ...artifact.awsRuntimeVerification, services: [{ serviceId: ids[0], verified: true }] } },
]) assert.throws(() => service.validatedReleaseEvidence(operation, invalid), /complete|does not match/);
const partialArtifact = { ...artifact, awsRuntimeVerification: { ...artifact.awsRuntimeVerification, verified: false, services: [runtimeOutcomes[0], { serviceId: ids[1], verified: false, failureCode: "DG_ECS_STABILITY_FAILED" }] } };
const partial = service.validatedReleaseEvidence(operation, partialArtifact);
assert.deepEqual(partial.services.map((item: any) => item.serviceId), [ids[0]], "only the independently verified service is eligible for promotion");
const candidateA = { serviceId: ids[0], revision: "candidate-a" };
assert.deepEqual(promotedServiceRevisions([candidateA], ids), [candidateA], "A is promoted while failed B remains outside LIVE authority");
const release: any = { id: "55555555-5555-4555-8555-555555555555", generationId: operationId, deployedByPipelineRunId: operationId, commitSha: sourceSha, metadata: { releaseEvidenceVerified: true, services: valid.services } };
console.log("MULTI_SERVICE_RELEASE=PASS COMPLETE_OUTCOMES_REQUIRED=1 TERMINAL_EVIDENCE_HANDOFF=1 RUNTIME_CONFIG_IDS=1 PARTIAL_PROMOTION=1 FAILED_SERVICE_LIVE=0");
