import "reflect-metadata";
import { strict as assert } from "node:assert";
import { CloudWatchClient, GetMetricDataCommand } from "@aws-sdk/client-cloudwatch";
import { DescribeServicesCommand, DescribeTaskDefinitionCommand, ECSClient, ListTagsForResourceCommand } from "@aws-sdk/client-ecs";
import { DescribeLoadBalancersCommand, DescribeTargetGroupsCommand, ElasticLoadBalancingV2Client } from "@aws-sdk/client-elastic-load-balancing-v2";
import { CustomerRuntimeEvidenceService } from "../src/operational-intelligence/customer-runtime-evidence.service";
import { measuredOptimization } from "../src/operational-intelligence/intelligence-evidence";
import { planFingerprint } from "../src/planning/deployment-plan";
import { Project } from "../src/projects/project.entity";

async function main() {
  const project = { id: "11111111-1111-4111-8111-111111111111", organizationId: "22222222-2222-4222-8222-222222222222", awsAccountBindingId: "33333333-3333-4333-8333-333333333333", environmentName: "staging", executionMode: "customer" } as Project;
  const serviceId = "44444444-4444-4444-8444-444444444444"; const accountId = "123456789012"; const region = "us-east-1"; const name = "dg-111111111111";
  const digest = `sha256:${"a".repeat(64)}`; const ecsPrefix = `arn:aws:ecs:${region}:${accountId}`; const lbPrefix = `arn:aws:elasticloadbalancing:${region}:${accountId}`;
  const identity = { region, ecsClusterArn: `${ecsPrefix}:cluster/${name}`, ecsServiceArn: `${ecsPrefix}:service/${name}/${name}-web`, taskDefinitionArn: `${ecsPrefix}:task-definition/${name}-web:1`, albArn: `${lbPrefix}:loadbalancer/app/owned/123`, targetGroupArn: `${lbPrefix}:targetgroup/owned/123`, publicUrl: "https://owned.us-east-1.elb.amazonaws.com", applicationContainerName: "app" };
  const plan = { operationId: "55555555-5555-4555-8555-555555555555", ownership: { bindingId: project.awsAccountBindingId, accountId, region, environment: "staging" }, selectedProfile: "ecs_fargate", repository: { sourceSha: "b".repeat(40) }, services: [{ id: serviceId }] };
  const record = { releaseId: "release", sourceSha: plan.repository.sourceSha, revisionSourceSha: plan.repository.sourceSha, operationId: plan.operationId, deployedAt: new Date(Date.now() - 48 * 3600_000), generationId: "generation", identity, accountId, imageDigest: digest, imageUri: `${accountId}.dkr.ecr.${region}.amazonaws.com/owned@${digest}`, plan, planFingerprint: planFingerprint(plan) };
  let selected: any = record; let owned = true; let sessionCalls = 0; let awsCalls = 0;
  const service = new CustomerRuntimeEvidenceService({ query: async () => selected ? [selected] : [] } as never, { withEcsSession: async (scope: any, callback: any) => { assert.equal(scope.purpose, "read"); assert.equal(scope.bindingId, project.awsAccountBindingId); assert.equal(scope.organizationId, project.organizationId); assert.equal(scope.projectId, project.id); sessionCalls++; return callback({ accountId, region, credentials: { accessKeyId: "fixture", secretAccessKey: "fixture-secret", sessionToken: "fixture-session" } }); } } as never);
  const original = [ECSClient.prototype.send, CloudWatchClient.prototype.send, ElasticLoadBalancingV2Client.prototype.send] as const;
  (ECSClient.prototype as any).send = async function(command: any) { awsCalls++; const credentials = await this.config.credentials(); assert.equal(credentials.accessKeyId, "fixture");
    if (command instanceof DescribeServicesCommand) return { services: [{ serviceArn: identity.ecsServiceArn, clusterArn: identity.ecsClusterArn, taskDefinition: identity.taskDefinitionArn, status: "ACTIVE", desiredCount: 2, loadBalancers: [{ targetGroupArn: identity.targetGroupArn, containerName: "app" }] }] };
    if (command instanceof DescribeTaskDefinitionCommand) return { taskDefinition: { taskDefinitionArn: identity.taskDefinitionArn, cpu: "1024", memory: "2048", containerDefinitions: [{ name: "app", image: record.imageUri }] } };
    if (command instanceof ListTagsForResourceCommand) return { tags: [{ key: "ManagedBy", value: "DeployGuard" }, { key: "DeployGuardProjectId", value: owned ? project.id : "foreign-project" }] };
    throw new Error("Unexpected ECS command");
  };
  (CloudWatchClient.prototype as any).send = async function(command: any) { awsCalls++; assert(command instanceof GetMetricDataCommand); assert.deepEqual(command.input.MetricDataQueries[0].MetricStat.Metric.Dimensions, [{ Name: "ClusterName", Value: name }, { Name: "ServiceName", Value: `${name}-web` }]); const end = command.input.EndTime.getTime(); const timestamps = Array.from({ length: 289 }, (_, index) => new Date(end - 24 * 3600_000 + index * 5 * 60_000)); return { MetricDataResults: [ { Id: "cpu", StatusCode: "Complete", Timestamps: timestamps, Values: timestamps.map(() => 15) }, { Id: "memory", StatusCode: "Complete", Timestamps: timestamps, Values: timestamps.map(() => 20) } ] }; };
  (ElasticLoadBalancingV2Client.prototype as any).send = async function(command: any) { awsCalls++; if (command instanceof DescribeLoadBalancersCommand) return { LoadBalancers: [{ LoadBalancerArn: identity.albArn, DNSName: "owned.us-east-1.elb.amazonaws.com" }] }; if (command instanceof DescribeTargetGroupsCommand) return { TargetGroups: [{ TargetGroupArn: identity.targetGroupArn, LoadBalancerArns: [identity.albArn] }] }; throw new Error("Unexpected ELB command"); };
  try {
    const observed = await service.measure(project, serviceId); assert.equal(observed.allocation.cpu, 1); assert.equal(observed.allocation.memoryMiB, 2048);
    assert.equal(measuredOptimization(observed.rows, observed.allocation, observed.start, observed.end, record.releaseId, serviceId).status, "recommendation");
    assert(!JSON.stringify(observed).includes("fixture-secret"));
    const api = await service.apiTarget(project, serviceId); assert.equal(api.origin, identity.publicUrl); assert.equal(api.sourceSha, record.sourceSha);
    owned = false; await assert.rejects(() => service.measure(project, serviceId)); owned = true;
    selected = { ...record, identity: { ...identity, ecsServiceArn: `arn:aws:ecs:${region}:999999999999:service/${name}/${name}-web` } }; const before = sessionCalls; await assert.rejects(() => service.measure(project, serviceId)); assert.equal(sessionCalls, before, "foreign scope rejects before assuming credentials");
    selected = { ...record, planFingerprint: "0".repeat(64) }; await assert.rejects(() => service.measure(project, serviceId)); assert.equal(sessionCalls, before);
    selected = { ...record, deployedAt: new Date() }; const shortWindow = await service.measure(project, serviceId); assert.equal(shortWindow.rows.length, 0, "prior-release metrics must not be relabeled as a new release");
    selected = null; const cloudBefore = awsCalls; await assert.rejects(() => service.apiTarget(project, serviceId)); assert.equal(awsCalls, cloudBefore);
    console.log("Focused mocked customer runtime account, source, plan, tags, images, endpoint and measured-window checks passed.");
  } finally { [ECSClient.prototype.send, CloudWatchClient.prototype.send, ElasticLoadBalancingV2Client.prototype.send] = original; }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
