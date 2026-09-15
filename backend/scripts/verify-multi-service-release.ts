import "reflect-metadata";
import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { RailpackDeploymentService } from "../src/projects/railpack-deployment.service";
import { servicesBase64, RailpackRuntimeConfiguration } from "../src/projects/railpack-workflow-contract";
import { resolveProjectApplicationUrl } from "../src/projects/application-entrypoint";

const projectId = "11111111-1111-4111-8111-111111111111";
const operationId = "22222222-2222-4222-8222-222222222222";
const ids = ["33333333-3333-4333-8333-333333333333", "44444444-4444-4444-8444-444444444444"];
const sourceSha = "a".repeat(40);
const runtime: RailpackRuntimeConfiguration = { schemaVersion: 3, projectId, operationId, environmentName: "dev", sourceSha, services: ids.map((serviceId, index) => { const serviceDirectory = index ? "api" : "web"; const fingerprint = (index ? "d" : "c").repeat(64); return ({ serviceId, runtimeConfigRevisionId: `${index ? "66666666-6666-4666-8666-666666666666" : "55555555-5555-4555-8555-555555555555"}`, runtimeConfigFingerprint: (index ? "f" : "e").repeat(64), buildTargetRevisionId: serviceId, buildTarget: { resolverVersion: "deployguard.build-target/v2", sourceSha, serviceDirectory, workspaceRoot: serviceDirectory, buildRoot: serviceDirectory, installRoot: serviceDirectory, packageIdentity: index ? "api" : "web", contract: "JS_STANDALONE", execution: { packageTarget: null, packageManager: "npm", buildCommand: null, startCommand: null }, dependencyPaths: [], strategy: "isolated", status: "resolved", evidence: {}, override: null, fingerprint }, serviceName: index ? "API" : "Web", serviceDirectory, servicePort: index ? 8000 : 3000, buildEnvironment: {}, buildSecretReferences: {}, environment: { PORT: String(index ? 8000 : 3000), HOST: "0.0.0.0", RELEASE: index ? "api" : "web" }, secretReferences: { TOKEN: `arn:aws:secretsmanager:us-east-1:123456789012:secret:deployguard/${serviceId}:TOKEN::${index ? "b".repeat(64) : "a".repeat(64)}` }, databaseAttached: index === 1, managedDatabase: index === 1 ? { engine: "postgres", aliases: ["DATABASE_URL"], urlScheme: "postgresql+psycopg" } : { engine: null, aliases: [] } }); }) };
const service = Object.create(RailpackDeploymentService.prototype) as any;
const operation: any = { id: operationId, commitSha: sourceSha, metadata: { deploymentAction: "deploy", immutableDispatchInputs: { services_base64: servicesBase64(runtime) } } };
const serviceEvidence = runtime.services.map((expected, index) => {
  const imageUri = `123456789012.dkr.ecr.us-east-1.amazonaws.com/dg-${index}`;
  const imageDigest = `sha256:${String(index + 1).repeat(64)}`;
  return { ...expected, environment: undefined, secretReferences: undefined, databaseAttached: undefined, managedDatabase: undefined, buildTarget: undefined, buildEnvironment: undefined, buildSecretReferences: undefined, builder: "railpack", builderVersion: "0.38.0", sourceSha, operationId, buildTargetFingerprint: expected.buildTarget!.fingerprint, localImageId: `sha256:${(index ? "8" : "7").repeat(64)}`, originalRailpackFailureCode: null, fallbackEligibility: "not_applicable", fallbackReason: null, fallbackTemplateId: null, fallbackTemplateVersion: null, fallbackTemplateDigest: null, imageUri, imageDigest, image: `${imageUri}@${imageDigest}` };
});
const terraformServices = Object.fromEntries(serviceEvidence.map((item, index) => [item.serviceId, { image: item.image, runtime_config_revision_id: item.runtimeConfigRevisionId, service_port: item.servicePort, public_url: `http://service-${index}.example.test`, task_definition_arn: `arn:aws:ecs:us-east-1:123456789012:task-definition/dg-${index}:1`, ecs_service_arn: `arn:aws:ecs:us-east-1:123456789012:service/dg/dg-${index}`, ecs_service_name: `dg-${index}`, alb_arn: `arn:aws:elasticloadbalancing:us-east-1:123456789012:loadbalancer/app/dg/${index}`, alb_name: `dg-${index}`, alb_target_group_arn: `arn:aws:elasticloadbalancing:us-east-1:123456789012:targetgroup/dg/${index}`, alb_target_group_name: `dg-${index}`, cloudwatch_log_group_name: `/deployguard/${projectId}/services/${item.serviceId}`, application_container_name: "application", transport_probe_container_name: "deployguard-transport-probe", transport_probe_port: 65535, platform_health_check_path: "/_deployguard/transport-ready" }]));
const database = { attached_service_id: ids[1], engine: "postgres", host: "database.internal", port: 5432, ecs_service_arn: "arn:aws:ecs:us-east-1:123456789012:service/dg/database", ecs_service_name: "database", task_definition_arn: "arn:aws:ecs:us-east-1:123456789012:task-definition/database:1", cloudwatch_log_group_name: `/deployguard/${projectId}/database`, credentials_secret_arn: "arn:aws:secretsmanager:us-east-1:123456789012:secret:deployguard/database", secret_version_id: "terraform-20260901000000000000000001" };
const runtimeOutcomes = runtime.services.map((expected, index) => ({
  serviceId: expected.serviceId,
  verified: true,
  image: terraformServices[expected.serviceId].image,
  ecsServiceArn: terraformServices[expected.serviceId].ecs_service_arn,
  taskDefinitionArn: terraformServices[expected.serviceId].task_definition_arn,
  runningTaskArns: [`arn:aws:ecs:us-east-1:123456789012:task/dg/${index + 1}`],
  ecsTasksRunning: 1,
  taskIpAddresses: [`10.0.0.${index + 10}`],
  runtimePort: expected.servicePort,
  readinessMode: "platform_transport",
  applicationReachabilityPath: "alb_to_task_eni",
  transportProbePort: terraformServices[expected.serviceId].transport_probe_port,
  platformHealthCheckPath: terraformServices[expected.serviceId].platform_health_check_path,
  targetGroupArn: terraformServices[expected.serviceId].alb_target_group_arn,
  targetHealth: ["healthy"],
  targetRegistrations: [{ targetId: `10.0.0.${index + 10}`, port: expected.servicePort, state: "healthy" }],
  alb: { state: "active", dnsName: `service-${index}.example.test`, scheme: "internet-facing", type: "application", ipAddressType: "ipv4", securityGroups: [`sg-${index}`] },
  listener: { listenerArn: `listener-${index}`, port: 80, protocol: "HTTP", defaultTargetGroupArn: terraformServices[expected.serviceId].alb_target_group_arn },
  publicProbe: { classification: "READY", hostname: `service-${index}.example.test`, resolvedIpAddresses: [`203.0.113.${index + 10}`], dnsAttempts: 1, dnsElapsedSeconds: 0, attemptCount: 1, elapsedSeconds: 0, curlExitCode: 0, httpStatus: "200", remoteIp: `203.0.113.${index + 10}`, connectTimeSeconds: "0.01", startTransferTimeSeconds: "0.02", totalTimeSeconds: "0.02" },
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
const artifact: any = { contractVersion: "deployguard.release-result/v5", action: "deploy", sourceSha, operationId, services: serviceEvidence, terraform, awsRuntimeVerification };

const handoffDirectory = mkdtempSync(join(tmpdir(), "deployguard-release-evidence-handoff-"));
const artifactsPath = join(handoffDirectory, "service-artifacts.json");
const terraformPath = join(handoffDirectory, "terraform-outputs.json");
const evidencePath = join(handoffDirectory, "aws-runtime-evidence.json");
const resultPath = join(handoffDirectory, "deployguard-result.json");
writeFileSync(artifactsPath, JSON.stringify(serviceEvidence), "utf8");
writeFileSync(terraformPath, JSON.stringify(terraform), "utf8");
writeFileSync(evidencePath, JSON.stringify(awsRuntimeVerification), "utf8");
const producer = join(__dirname, "..", "..", "infrastructure", "railpack-runtime", "build-release-result.sh");
const produced = spawnSync("bash", [producer, "deploy", "deployguard.release-result/v5", sourceSha, operationId, artifactsPath, terraformPath, evidencePath, resultPath], { encoding: "utf8" });
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
  assert.equal(outcome.runtimePort, runtime.services[index].servicePort);
  assert.equal(outcome.readinessMode, "platform_transport");
  assert.equal(outcome.transportProbePort, 65535);
  assert.equal(outcome.platformHealthCheckPath, "/_deployguard/transport-ready");
  assert.deepEqual(outcome.targetHealth, ["healthy"]);
  assert.deepEqual(outcome.environment, runtime.services[index].environment);
  assert.deepEqual(outcome.secretValueFrom.TOKEN, runtime.services[index].secretReferences.TOKEN);
  assert.equal(outcome.publicUrl, terraformServices[ids[index]].public_url);
}
assert.equal(handoff.serviceOutcomes[1].managedDatabase.secretVersionId, database.secret_version_id);
assert.equal(handoff.serviceOutcomes[1].secretValueFrom.DATABASE_URL, `${database.credentials_secret_arn}:url::${database.secret_version_id}`);
assert.equal(resolveProjectApplicationUrl(ids[0], handoff.services), terraformServices[ids[0]].public_url, "the configured application entrypoint retains its verified public endpoint");

writeFileSync(evidencePath, JSON.stringify({ ...awsRuntimeVerification, services: [] }), "utf8");
const rejected = spawnSync("bash", [producer, "deploy", "deployguard.release-result/v5", sourceSha, operationId, artifactsPath, terraformPath, evidencePath, join(handoffDirectory, "invalid-result.json")], { encoding: "utf8" });
assert.notEqual(rejected.status, 0, "the workflow producer must fail before upload when terminal AWS evidence is incomplete");
assert.match(rejected.stderr, /DG_WORKFLOW_CONTRACT_INVALID stage=release_evidence_validation/);
const missingPublicProbeEvidence = structuredClone(awsRuntimeVerification) as any;
delete missingPublicProbeEvidence.services[0].publicProbe;
writeFileSync(evidencePath, JSON.stringify(missingPublicProbeEvidence), "utf8");
const missingPublicProbe = spawnSync("bash", [producer, "deploy", "deployguard.release-result/v5", sourceSha, operationId, artifactsPath, terraformPath, evidencePath, join(handoffDirectory, "missing-public-probe.json")], { encoding: "utf8" });
assert.notEqual(missingPublicProbe.status, 0, "the terminal artifact producer must reject SUCCESS evidence without public ALB-path proof");
const valid = service.validatedReleaseEvidence(operation, artifact);
assert.equal(valid.services.length, 2);
assert.deepEqual(valid.services.map((item: any) => item.serviceId), ids);
const rollbackOperation: any = { ...operation, projectId, metadata: { deploymentAction: "rollback", immutableDispatchInputs: { services_base64: servicesBase64(runtime), trivy_enabled: "true", trivy_enforce: "false" } } };
const rollbackArtifact = { ...artifact, action: "rollback" };
assert.doesNotThrow(() => service.validatedReleaseEvidence(rollbackOperation, rollbackArtifact), "rollback reuses historically scanned immutable images without manufacturing a new operation-scoped Trivy scan");
assert.throws(() => service.validatedReleaseEvidence(rollbackOperation, { ...rollbackArtifact, securityScan: { contractVersion: "deployguard.security-result/v1" } }), /unrequested Trivy scan/, "rollback rejects unexpected new scan evidence");
const trivyDeployOperation: any = { ...operation, projectId, metadata: { deploymentAction: "deploy", immutableDispatchInputs: { services_base64: servicesBase64(runtime), trivy_enabled: "true", trivy_enforce: "false" } } };
assert.throws(() => service.validatedReleaseEvidence(trivyDeployOperation, artifact), /valid Trivy evidence/, "new deployments still require operation-scoped Trivy evidence when enabled");
for (const invalid of [
  { ...artifact, services: artifact.services.slice(0, 1) },
  { ...artifact, services: [artifact.services[0], artifact.services[0]] },
  { ...artifact, terraform: { ...artifact.terraform, services: { [ids[0]]: terraformServices[ids[0]] } } },
  { ...artifact, awsRuntimeVerification: { ...artifact.awsRuntimeVerification, services: [{ serviceId: ids[0], verified: true }] } },
]) assert.throws(() => service.validatedReleaseEvidence(operation, invalid), /complete|does not match/);
for (const mutate of [
  (candidate: any) => { delete candidate.awsRuntimeVerification.services[0].taskIpAddresses; },
  (candidate: any) => { candidate.awsRuntimeVerification.services[0].targetRegistrations[0].port = 9090; },
  (candidate: any) => { candidate.awsRuntimeVerification.services[0].listener.defaultTargetGroupArn = "wrong-target-group"; },
  (candidate: any) => { candidate.awsRuntimeVerification.services[0].publicProbe.httpStatus = "503"; },
]) {
  const invalid = structuredClone(artifact);
  mutate(invalid);
  assert.throws(() => service.validatedReleaseEvidence(operation, invalid), /does not match/, "backend ingestion must reject incomplete or mismatched production-path evidence");
}
const partialArtifact = { ...artifact, awsRuntimeVerification: { ...artifact.awsRuntimeVerification, verified: false, services: [runtimeOutcomes[0], { serviceId: ids[1], verified: false, failureCode: "DG_ECS_STABILITY_FAILED" }] } };
assert.throws(() => service.validatedReleaseEvidence(operation, partialArtifact), /verified AWS runtime evidence|failed or unknown service outcome/, "verified=false cannot be consumed as a successful release");
writeFileSync(evidencePath, JSON.stringify(partialArtifact.awsRuntimeVerification), "utf8");
for (const action of ["deploy", "rollback"] as const) {
  const partialProduced = spawnSync("bash", [producer, action, "deployguard.release-result/v5", sourceSha, operationId, artifactsPath, terraformPath, evidencePath, join(handoffDirectory, `partial-${action}-result.json`)], { encoding: "utf8" });
  assert.notEqual(partialProduced.status, 0, `verified=false cannot produce a successful ${action} release result`);
  assert.match(partialProduced.stderr, /DG_WORKFLOW_CONTRACT_INVALID stage=release_evidence_validation/);
}
rmSync(handoffDirectory, { recursive: true, force: true });

const shapes = [
  { name: "flask-root", directories: ["."], ports: [5000], databaseEngine: null },
  { name: "fullstack-mongodb", directories: ["frontend", "backend"], ports: [2997, 5000], databaseEngine: "mongodb" },
  { name: "rentmate-mongodb", directories: ["frontend", "backend"], ports: [3000, 3001], databaseEngine: "mongodb" },
  { name: "smart-retail-postgresql", directories: ["."], ports: [4997], databaseEngine: "postgres" },
] as const;
for (const shape of shapes) {
  const selectedIds = ids.slice(0, shape.ports.length);
  const attachedServiceId = shape.databaseEngine ? selectedIds.at(-1)! : null;
  const shapeDatabase = shape.databaseEngine ? { ...database, attached_service_id: attachedServiceId, engine: shape.databaseEngine, port: shape.databaseEngine === "mongodb" ? 27017 : 5432 } : null;
  const shapeServices = selectedIds.map((serviceId, index) => ({
    ...runtime.services[index], serviceId, serviceName: index ? "Backend" : shape.ports.length > 1 ? "Frontend" : "Application", serviceDirectory: shape.directories[index], servicePort: shape.ports[index],
    buildTargetRevisionId: serviceId,
    buildTarget: { ...runtime.services[index].buildTarget!, serviceDirectory: shape.directories[index], workspaceRoot: shape.directories[index], buildRoot: shape.directories[index], installRoot: shape.directories[index] },
    environment: { PORT: String(shape.ports[index]), HOST: "0.0.0.0", RELEASE: index ? "api" : "web" },
    databaseAttached: serviceId === attachedServiceId,
    managedDatabase: serviceId === attachedServiceId ? { engine: shape.databaseEngine, aliases: [shape.databaseEngine === "mongodb" ? "MONGODB_URI" : "DATABASE_URL"], urlScheme: shape.databaseEngine === "postgres" ? "postgresql" : shape.databaseEngine } : { engine: null, aliases: [] },
  }));
  const shapeRuntime: RailpackRuntimeConfiguration = { ...runtime, services: shapeServices as RailpackRuntimeConfiguration["services"] };
  const shapeTerraformServices = Object.fromEntries(shapeServices.map((expected, index) => [expected.serviceId, { ...terraformServices[expected.serviceId], service_port: expected.servicePort, public_url: `http://${shape.name}-${index}.example.test` }]));
  const shapeArtifacts = shapeServices.map((expected, index) => ({ ...serviceEvidence[index], serviceId: expected.serviceId, serviceName: expected.serviceName, serviceDirectory: expected.serviceDirectory, servicePort: expected.servicePort, buildTargetRevisionId: expected.buildTargetRevisionId, buildTargetFingerprint: expected.buildTarget!.fingerprint, runtimeConfigFingerprint: expected.runtimeConfigFingerprint }));
  const shapeOutcomes = shapeServices.map((expected, index) => {
    const managedSecret = expected.databaseAttached ? { [expected.managedDatabase.aliases[0]]: `${shapeDatabase!.credentials_secret_arn}:url::${shapeDatabase!.secret_version_id}` } : {};
    return { ...runtimeOutcomes[index], serviceId: expected.serviceId, image: shapeTerraformServices[expected.serviceId].image, ecsServiceArn: shapeTerraformServices[expected.serviceId].ecs_service_arn, taskDefinitionArn: shapeTerraformServices[expected.serviceId].task_definition_arn, runtimePort: expected.servicePort, targetGroupArn: shapeTerraformServices[expected.serviceId].alb_target_group_arn, targetRegistrations: [{ targetId: `10.0.0.${index + 10}`, port: expected.servicePort, state: "healthy" }], alb: { ...runtimeOutcomes[index].alb, dnsName: `${shape.name}-${index}.example.test` }, publicProbe: { ...runtimeOutcomes[index].publicProbe, hostname: `${shape.name}-${index}.example.test` }, environment: expected.environment, secretValueFrom: { ...expected.secretReferences, ...managedSecret }, managedDatabase: expected.databaseAttached ? { attached: true, attachedServiceId: expected.serviceId, engine: shape.databaseEngine, aliases: expected.managedDatabase.aliases, credentialsSecretArn: shapeDatabase!.credentials_secret_arn, secretVersionId: shapeDatabase!.secret_version_id } : { attached: false, attachedServiceId: null, engine: null, aliases: [], credentialsSecretArn: null, secretVersionId: null }, publicUrl: shapeTerraformServices[expected.serviceId].public_url };
  });
  const shapeTerraform = { ...terraform, services: shapeTerraformServices, database: shapeDatabase };
  const shapeVerification = { ...awsRuntimeVerification, services: shapeOutcomes, databaseVerified: Boolean(shapeDatabase) };
  const shapeDirectory = mkdtempSync(join(tmpdir(), `deployguard-${shape.name}-`));
  const shapeArtifactsPath = join(shapeDirectory, "artifacts.json"); const shapeTerraformPath = join(shapeDirectory, "terraform.json"); const shapeEvidencePath = join(shapeDirectory, "evidence.json"); const shapeResultPath = join(shapeDirectory, "result.json");
  writeFileSync(shapeArtifactsPath, JSON.stringify(shapeArtifacts), "utf8"); writeFileSync(shapeTerraformPath, JSON.stringify(shapeTerraform), "utf8"); writeFileSync(shapeEvidencePath, JSON.stringify(shapeVerification), "utf8");
  const producedShape = spawnSync("bash", [producer, "deploy", "deployguard.release-result/v5", sourceSha, operationId, shapeArtifactsPath, shapeTerraformPath, shapeEvidencePath, shapeResultPath], { encoding: "utf8" });
  assert.equal(producedShape.status, 0, `${shape.name}: ${producedShape.stderr}`);
  const shapeOperation: any = { ...operation, metadata: { deploymentAction: "deploy", immutableDispatchInputs: { services_base64: servicesBase64(shapeRuntime) } } };
  const parsedShape = service.validatedReleaseEvidence(shapeOperation, JSON.parse(readFileSync(shapeResultPath, "utf8")));
  assert.deepEqual(parsedShape.services.map((item: any) => [item.serviceDirectory, item.servicePort]), shape.directories.map((directory, index) => [directory, shape.ports[index]]));
  assert.equal(parsedShape.awsRuntimeVerification.databaseVerified, Boolean(shapeDatabase));
  rmSync(shapeDirectory, { recursive: true, force: true });
}
const release: any = { id: "55555555-5555-4555-8555-555555555555", generationId: operationId, deployedByPipelineRunId: operationId, commitSha: sourceSha, metadata: { releaseEvidenceVerified: true, services: valid.services } };
console.log("MULTI_SERVICE_RELEASE=PASS COMPLETE_OUTCOMES_REQUIRED=1 TERMINAL_EVIDENCE_HANDOFF=1 RUNTIME_CONFIG_IDS=1 VERIFIED_FALSE_REJECTED=1 FLASK_SHAPE=1 FULLSTACK_SHAPE=1 RENTMATE_SHAPE=1 SMART_RETAIL_SHAPE=1 FAILED_SERVICE_LIVE=0");
