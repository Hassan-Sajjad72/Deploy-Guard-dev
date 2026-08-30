import "reflect-metadata";
import { strict as assert } from "node:assert";
import { RailpackDeploymentService } from "../src/projects/railpack-deployment.service";
import { servicesBase64, RailpackRuntimeConfiguration } from "../src/projects/railpack-workflow-contract";

const projectId = "11111111-1111-4111-8111-111111111111";
const operationId = "22222222-2222-4222-8222-222222222222";
const ids = ["33333333-3333-4333-8333-333333333333", "44444444-4444-4444-8444-444444444444"];
const sourceSha = "a".repeat(40);
const runtime: RailpackRuntimeConfiguration = { schemaVersion: 2, projectId, operationId, environmentName: "dev", sourceSha, services: ids.map((serviceId, index) => ({ serviceId, runtimeConfigRevisionId: `${index ? "66666666-6666-4666-8666-666666666666" : "55555555-5555-4555-8555-555555555555"}`, serviceName: index ? "API" : "Web", serviceDirectory: index ? "api" : "web", environment: { PORT: "8080", HOST: "0.0.0.0" }, secretReferences: {}, databaseAttached: false, managedDatabase: { engine: null, aliases: [] } })) };
const service = Object.create(RailpackDeploymentService.prototype) as any;
const operation: any = { id: operationId, commitSha: sourceSha, metadata: { deploymentAction: "deploy", immutableDispatchInputs: { services_base64: servicesBase64(runtime) } } };
const serviceEvidence = runtime.services.map((expected, index) => {
  const imageUri = `123456789012.dkr.ecr.us-east-1.amazonaws.com/dg-${index}`;
  const imageDigest = `sha256:${String(index + 1).repeat(64)}`;
  return { ...expected, environment: undefined, secretReferences: undefined, databaseAttached: undefined, managedDatabase: undefined, imageUri, imageDigest, image: `${imageUri}@${imageDigest}` };
});
const terraformServices = Object.fromEntries(serviceEvidence.map((item, index) => [item.serviceId, { image: item.image, runtime_config_revision_id: item.runtimeConfigRevisionId, public_url: `http://service-${index}.example.test`, task_definition_arn: `arn:aws:ecs:us-east-1:123456789012:task-definition/dg-${index}:1`, ecs_service_arn: `arn:aws:ecs:us-east-1:123456789012:service/dg/dg-${index}`, ecs_service_name: `dg-${index}`, alb_arn: `arn:aws:elasticloadbalancing:us-east-1:123456789012:loadbalancer/app/dg/${index}`, alb_name: `dg-${index}`, alb_target_group_arn: `arn:aws:elasticloadbalancing:us-east-1:123456789012:targetgroup/dg/${index}`, alb_target_group_name: `dg-${index}`, cloudwatch_log_group_name: `/deployguard/${projectId}/services/${item.serviceId}`, application_container_name: "application" }]));
const artifact: any = { contractVersion: "deployguard.release-result/v4", action: "deploy", sourceSha, operationId, services: serviceEvidence, terraform: { aws_region: "us-east-1", ecs_cluster_arn: "arn:aws:ecs:us-east-1:123456789012:cluster/dg", ecs_cluster_name: "dg", services: terraformServices, database: null } };

const valid = service.validatedReleaseEvidence(operation, artifact);
assert.equal(valid.services.length, 2);
assert.deepEqual(valid.services.map((item: any) => item.serviceId), ids);
for (const invalid of [
  { ...artifact, services: artifact.services.slice(0, 1) },
  { ...artifact, services: [artifact.services[0], artifact.services[0]] },
  { ...artifact, terraform: { ...artifact.terraform, services: { [ids[0]]: terraformServices[ids[0]] } } },
]) assert.throws(() => service.validatedReleaseEvidence(operation, invalid), /complete|does not match/);
const release: any = { id: "55555555-5555-4555-8555-555555555555", generationId: operationId, deployedByPipelineRunId: operationId, commitSha: sourceSha, metadata: { releaseEvidenceVerified: true, services: valid.services } };
console.log("MULTI_SERVICE_RELEASE=PASS COMPLETE_SET_REQUIRED=1 RUNTIME_CONFIG_IDS=1 PARTIAL_PROMOTION=0");
