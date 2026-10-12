import "reflect-metadata";
import { strict as assert } from "node:assert";
import { CloudWatchClient, GetMetricDataCommand } from "@aws-sdk/client-cloudwatch";
import { DescribeServicesCommand, DescribeTaskDefinitionCommand, ECSClient, ListTagsForResourceCommand, ListTasksCommand } from "@aws-sdk/client-ecs";
import { DescribeLoadBalancersCommand, DescribeTagsCommand, DescribeTargetGroupsCommand, DescribeTargetHealthCommand, ElasticLoadBalancingV2Client } from "@aws-sdk/client-elastic-load-balancing-v2";
import { CloudWatchLogsClient, FilterLogEventsCommand } from "@aws-sdk/client-cloudwatch-logs";
import { ConfigService } from "@nestjs/config";
import { LiveRuntimeResolverService } from "../src/observability/live-runtime-resolver.service";
import { CloudWatchLogsService } from "../src/observability/cloudwatch-logs.service";
import { CloudWatchMetricsService } from "../src/observability/cloudwatch-metrics.service";
import { LogSanitizerService } from "../src/observability/log-sanitizer.service";
import { ProjectCurrentStateService } from "../src/projects/current-state/project-current-state.service";
import { CustomerRuntimeEvidenceService } from "../src/operational-intelligence/customer-runtime-evidence.service";
import { measuredOptimization } from "../src/operational-intelligence/intelligence-evidence";
import { planFingerprint } from "../src/planning/deployment-plan";
import { Project } from "../src/projects/project.entity";

async function main() {
  const project = { id: "11111111-1111-4111-8111-111111111111", organizationId: "22222222-2222-4222-8222-222222222222", awsAccountBindingId: "33333333-3333-4333-8333-333333333333", environmentName: "staging", executionMode: "customer" } as Project;
  const serviceId = "44444444-4444-4444-8444-444444444444"; const accountId = "123456789012"; const region = "us-east-1"; const name = "dg-111111111111";
  const digest = `sha256:${"a".repeat(64)}`; const ecsPrefix = `arn:aws:ecs:${region}:${accountId}`; const lbPrefix = `arn:aws:elasticloadbalancing:${region}:${accountId}`;
  const identity = { region, ecsClusterArn: `${ecsPrefix}:cluster/${name}`, ecsServiceArn: `${ecsPrefix}:service/${name}/${name}-web`, taskDefinitionArn: `${ecsPrefix}:task-definition/${name}-web:1`, albArn: `${lbPrefix}:loadbalancer/app/owned/123`, targetGroupArn: `${lbPrefix}:targetgroup/owned/123`, publicUrl: "https://owned.us-east-1.elb.amazonaws.com", applicationContainerName: "app", cloudWatchLogGroupName: `/deployguard/${project.id}/services/${serviceId}` };
  const plan = { operationId: "55555555-5555-4555-8555-555555555555", ownership: { bindingId: project.awsAccountBindingId, accountId, region, environment: "staging" }, selectedProfile: "ecs_fargate", repository: { sourceSha: "b".repeat(40) }, services: [{ id: serviceId }] };
  const record = { releaseId: "release", sourceSha: plan.repository.sourceSha, revisionSourceSha: plan.repository.sourceSha, operationId: plan.operationId, deployedAt: new Date(Date.now() - 48 * 3600_000), generationId: "generation", identity, accountId, imageDigest: digest, imageUri: `${accountId}.dkr.ecr.${region}.amazonaws.com/owned@${digest}`, plan, planFingerprint: planFingerprint(plan) };
  let selected: any = record; let owned = true; let badLog = false; let changeDuringRead = false; let incompleteMetrics = false; let sessionCalls = 0; let awsCalls = 0; let logCalls = 0;
  const service = new CustomerRuntimeEvidenceService({ query: async () => selected ? [selected] : [] } as never, { withEcsSession: async (scope: any, callback: any) => { assert.equal(scope.purpose, "read"); assert.equal(scope.bindingId, project.awsAccountBindingId); assert.equal(scope.organizationId, project.organizationId); assert.equal(scope.projectId, project.id); sessionCalls++; return callback({ accountId, region, credentials: { accessKeyId: "fixture", secretAccessKey: "fixture-secret", sessionToken: "fixture-session" } }); } } as never);
  const original = [ECSClient.prototype.send, CloudWatchClient.prototype.send, ElasticLoadBalancingV2Client.prototype.send, CloudWatchLogsClient.prototype.send] as const;
  (ECSClient.prototype as any).send = async function(command: any) { awsCalls++; const credentials = await this.config.credentials(); assert.equal(credentials.accessKeyId, "fixture");
    if (command instanceof DescribeServicesCommand) return { services: [{ serviceArn: identity.ecsServiceArn, clusterArn: identity.ecsClusterArn, taskDefinition: identity.taskDefinitionArn, status: "ACTIVE", desiredCount: 2, runningCount: 2, pendingCount: 0, loadBalancers: [{ targetGroupArn: identity.targetGroupArn, containerName: "app" }] }] };
    if (command instanceof DescribeTaskDefinitionCommand) return { taskDefinition: { taskDefinitionArn: identity.taskDefinitionArn, cpu: "1024", memory: "2048", containerDefinitions: [{ name: "app", image: record.imageUri, logConfiguration: { logDriver: "awslogs", options: { "awslogs-region": region, "awslogs-group": badLog ? "/foreign/logs" : identity.cloudWatchLogGroupName, "awslogs-stream-prefix": "application" } } }] } };
    if (command instanceof ListTasksCommand) return { taskArns: [`${ecsPrefix}:task/${name}/owned`] };
    if (command instanceof ListTagsForResourceCommand) return { tags: [{ key: "ManagedBy", value: "DeployGuard" }, { key: "DeployGuardProjectId", value: owned ? project.id : "foreign-project" }] };
    throw new Error("Unexpected ECS command");
  };
  (CloudWatchClient.prototype as any).send = async function(command: any) {
    awsCalls++; assert(command instanceof GetMetricDataCommand); assert.equal((await this.config.credentials()).accessKeyId, "fixture");
    assert.deepEqual(command.input.MetricDataQueries[0].MetricStat.Metric.Dimensions, [{ Name: "ClusterName", Value: name }, { Name: "ServiceName", Value: `${name}-web` }]);
    const end = command.input.EndTime.getTime(); const timestamps = Array.from({ length: 289 }, (_, index) => new Date(end - 24 * 3600_000 + index * 5 * 60_000));
    return { MetricDataResults: command.input.MetricDataQueries.map((query: any) => ({ Id: query.Id, StatusCode: incompleteMetrics ? "PartialData" : "Complete", Timestamps: timestamps, Values: timestamps.map(() => query.Id === "healthy_hosts" ? 1 : query.Id === "unhealthy_hosts" ? 0 : query.Id.includes("memory") ? 20 : 15) })) };
  };
  (ElasticLoadBalancingV2Client.prototype as any).send = async function(command: any) { awsCalls++; assert.equal((await this.config.credentials()).accessKeyId, "fixture"); if (command instanceof DescribeLoadBalancersCommand) return { LoadBalancers: [{ LoadBalancerArn: identity.albArn, DNSName: "owned.us-east-1.elb.amazonaws.com" }] }; if (command instanceof DescribeTargetGroupsCommand) return { TargetGroups: [{ TargetGroupArn: identity.targetGroupArn, LoadBalancerArns: [identity.albArn] }] }; if (command instanceof DescribeTargetHealthCommand) return { TargetHealthDescriptions: [{ TargetHealth: { State: "healthy" } }] }; if (command instanceof DescribeTagsCommand) return { TagDescriptions: command.input.ResourceArns.map((ResourceArn: string) => ({ ResourceArn, Tags: [{ Key: "ManagedBy", Value: "DeployGuard" }, { Key: "DeployGuardProjectId", Value: project.id }] })) }; throw new Error("Unexpected ELB command"); };
  (CloudWatchLogsClient.prototype as any).send = async function(command: any) { logCalls++; assert(command instanceof FilterLogEventsCommand); assert.equal((await this.config.credentials()).sessionToken, "fixture-session"); assert.equal(command.input.logGroupName, identity.cloudWatchLogGroupName); if (changeDuringRead) selected = { ...record, releaseId: "new-release" }; return { events: [{ timestamp: Date.now(), eventId: "owned-event", message: "owned application output" }] }; };
  try {
    const observed = await service.measure(project, serviceId); assert.equal(observed.allocation.cpu, 1); assert.equal(observed.allocation.memoryMiB, 2048);
    assert.equal(measuredOptimization(observed.rows, observed.allocation, observed.start, observed.end, record.releaseId, serviceId).status, "recommendation");
    assert(!JSON.stringify(observed).includes("fixture-secret"));
    const api = await service.apiTarget(project, serviceId); assert.equal(api.origin, identity.publicUrl); assert.equal(api.sourceSha, record.sourceSha);
    const config = new ConfigService();
    const resolver = new LiveRuntimeResolverService({ findOne: async () => project } as never, {} as never, {} as never, config, { recover: async () => ({ services: [{ serviceId, serviceName: "Web" }] }) } as never, service);
    const runtime = await resolver.resolveProjectId(project.id, serviceId);
    assert.equal(runtime.executionMode, "customer"); assert.equal(runtime.logGroupName, identity.cloudWatchLogGroupName); assert(!JSON.stringify(runtime).includes("fixture-secret"));
    const currentState = Object.create(ProjectCurrentStateService.prototype) as any;
    currentState.customerRuntime = resolver;
    currentState.runtimeIdentityRecovery = { recover: async () => ({ services: [{ serviceId, serviceName: "Web", imageDigest: digest, imageUri: record.imageUri }] }) };
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async (url) => { assert.equal(url, identity.publicUrl); return new Response("Application failure", { status: 500 }); }) as typeof fetch;
      const state = await currentState.runtimeObservation(project, record.generationId, identity.publicUrl);
      assert.equal(state.runtime, "present"); assert.equal(state.evidence.applicationHealth.status, "failed"); assert.equal(state.resources.cloudWatch, "unknown");
      assert(!JSON.stringify(state).includes("fixture-secret"));
      owned = false; assert.equal((await currentState.runtimeObservation(project, record.generationId, identity.publicUrl)).runtime, "unknown", "revoked resource authority cannot reuse cached customer presence"); owned = true;
      assert.equal((await currentState.runtimeObservation(project, "wrong-generation", identity.publicUrl)).runtime, "unknown");
    } finally { globalThis.fetch = originalFetch; }
    const logs = new CloudWatchLogsService(config, resolver, new LogSanitizerService());
    const queried = await logs.getRecentLogs({ id: 1, role: "developer", organizationMemberships: [{ organizationId: project.organizationId, role: "engineer" }] } as any, project.id, {}, serviceId);
    assert.equal(queried.events[0].message, "owned application output");
    const metrics = new CloudWatchMetricsService(config, resolver, { dispatch: async () => {} } as never);
    assert.equal((await metrics.collect(runtime)).generationId, record.generationId);
    incompleteMetrics = true; await assert.rejects(() => metrics.collect(runtime), /incomplete runtime measurements/); incompleteMetrics = false;
    owned = false; await assert.rejects(() => metrics.collect(runtime)); owned = true;
    badLog = true; const beforeBadLog = logCalls; await assert.rejects(() => logs.getRecentLogs({ id: 1, role: "developer", organizationMemberships: [{ organizationId: project.organizationId, role: "engineer" }] } as any, project.id, {}, serviceId)); assert.equal(logCalls, beforeBadLog); badLog = false;
    changeDuringRead = true; await assert.rejects(() => logs.getRecentLogs({ id: 1, role: "developer", organizationMemberships: [{ organizationId: project.organizationId, role: "engineer" }] } as any, project.id, {}, serviceId), /release changed/); changeDuringRead = false; selected = record;
    owned = false; await assert.rejects(() => service.measure(project, serviceId)); owned = true;
    selected = { ...record, identity: { ...identity, ecsServiceArn: `arn:aws:ecs:${region}:999999999999:service/${name}/${name}-web` } }; const before = sessionCalls; await assert.rejects(() => service.measure(project, serviceId)); assert.equal(sessionCalls, before, "foreign scope rejects before assuming credentials");
    selected = { ...record, planFingerprint: "0".repeat(64) }; await assert.rejects(() => service.measure(project, serviceId)); assert.equal(sessionCalls, before);
    selected = { ...record, deployedAt: new Date() }; const shortWindow = await service.measure(project, serviceId); assert.equal(shortWindow.rows.length, 0, "prior-release metrics must not be relabeled as a new release");
    selected = null; const cloudBefore = awsCalls; await assert.rejects(() => service.apiTarget(project, serviceId)); assert.equal(awsCalls, cloudBefore);
    console.log("Focused mocked customer runtime account, source, plan, tags, images, endpoint and measured-window checks passed.");
  } finally { [ECSClient.prototype.send, CloudWatchClient.prototype.send, ElasticLoadBalancingV2Client.prototype.send, CloudWatchLogsClient.prototype.send] = original; }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
