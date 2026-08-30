import "reflect-metadata";
import { strict as assert } from "node:assert";
import { ConfigService } from "@nestjs/config";
import { CloudWatchLogsService } from "../src/observability/cloudwatch-logs.service";
import { AwsRuntimeUnavailableException, LiveRuntimeResolverService, RuntimeIdentityUnavailableException } from "../src/observability/live-runtime-resolver.service";
import { ObservabilityService } from "../src/observability/observability.service";
import { LogSanitizerService } from "../src/observability/log-sanitizer.service";
import { ProjectCurrentStateService } from "../src/projects/current-state/project-current-state.service";
import { LiveRuntimeIdentityRecoveryService } from "../src/projects/current-state/live-runtime-identity-recovery.service";

const project: any = { id: "11111111-1111-4111-8111-111111111111", environmentName: "dev" };
const generation: any = { id: "22222222-2222-4222-8222-222222222222", projectId: project.id, environmentName: "dev", status: "live", terraformStateKey: "projects/test/dev/runtime/terraform.tfstate", resourceManifest: { region: "wrong-region", services: [{ serviceId: "wrong" }] } };
const release: any = { id: "33333333-3333-4333-8333-333333333333", projectId: project.id, environmentName: "dev", generationId: generation.id, status: "stable", deployedByPipelineRunId: "44444444-4444-4444-8444-444444444444", metadata: { releaseEvidenceVerified: true, runtimeIdentity: { services: [{ serviceId: "wrong" }] } } };
const a = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const b = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const arn = (suffix: string) => `arn:aws:ecs:us-east-1:123456789012:${suffix}`;

function revision(serviceId: string, name: string) {
  return {
    projectId: project.id, generationId: generation.id, serviceId, serviceName: name, serviceDirectory: name.toLowerCase(), sourceSha: "a".repeat(40),
    imageUri: "123456789012.dkr.ecr.us-east-1.amazonaws.com/deployguard-test", imageDigest: `sha256:${serviceId.startsWith("a") ? "a" : "b"}`.padEnd(71, serviceId.startsWith("a") ? "a" : "b"), runtimeConfigRevisionId: serviceId,
    runtimeIdentity: {
      publicUrl: `https://${name.toLowerCase()}.example.test`, region: "us-east-1", ecsClusterArn: arn("cluster/project"), ecsClusterName: "project",
      ecsServiceArn: arn(`service/project/${name.toLowerCase()}`), ecsServiceName: name.toLowerCase(), taskDefinitionArn: arn(`task-definition/${name.toLowerCase()}:1`),
      albArn: `arn:aws:elasticloadbalancing:us-east-1:123456789012:loadbalancer/app/${name.toLowerCase()}/1`, albName: name.toLowerCase(),
      targetGroupArn: `arn:aws:elasticloadbalancing:us-east-1:123456789012:targetgroup/${name.toLowerCase()}/1`, targetGroupName: name.toLowerCase(),
      cloudWatchLogGroupName: `/deployguard/${project.id}/services/${serviceId}`, applicationContainerName: "application",
    },
  };
}

async function canonicalRevisionRecovery() {
  const recovery = new LiveRuntimeIdentityRecoveryService(
    { findOne: async () => generation } as never,
    { findOne: async () => release } as never,
    { findOne: async () => ({ projectId: project.id, environmentName: "dev", liveGenerationId: generation.id }) } as never,
    { find: async () => [revision(b, "API"), revision(a, "Web")] } as never,
  );
  const identity: any = await recovery.recover(project);
  assert.deepEqual(identity.services.map((service: any) => service.serviceId), [a, b], "canonical revisions define deterministic service order");
  assert.equal(identity.services[1].targetGroupArn, revision(b, "API").runtimeIdentity.targetGroupArn);
  assert.equal(identity.region, "us-east-1");
  assert.doesNotMatch(JSON.stringify(identity), /wrong-region|"wrong"/, "resource_manifest is not an authority when revisions exist");

  const resolver: any = Object.create(LiveRuntimeResolverService.prototype);
  resolver.projects = { findOne: async () => project };
  resolver.generations = { findOne: async () => generation };
  resolver.releases = { findOne: async () => release };
  resolver.runtimeIdentityRecovery = recovery;
  resolver.config = new ConfigService({ AWS_REGION: "us-east-1" });
  resolver.cache = new Map();
  resolver.ecs = () => ({ send: async (command: any) => {
    const name = command.constructor.name;
    if (name === "DescribeServicesCommand") return { services: [{ serviceArn: revision(b, "API").runtimeIdentity.ecsServiceArn, serviceName: "api", status: "ACTIVE", taskDefinition: revision(b, "API").runtimeIdentity.taskDefinitionArn }] };
    if (name === "DescribeTaskDefinitionCommand") return {
      taskDefinition: {
        containerDefinitions: [{
          name: "application",
          logConfiguration: { options: {
            "awslogs-group": revision(b, "API").runtimeIdentity.cloudWatchLogGroupName,
            "awslogs-stream-prefix": "ecs",
          } },
        }],
      },
    };
    return { taskArns: [arn("task/project/api")] };
  } });
  resolver.elb = () => ({ send: async (command: any) => command.constructor.name === "DescribeTargetGroupsCommand"
    ? { TargetGroups: [{ TargetGroupArn: revision(b, "API").runtimeIdentity.targetGroupArn, LoadBalancerArns: [revision(b, "API").runtimeIdentity.albArn] }] }
    : { TargetHealthDescriptions: [{ TargetHealth: { State: "healthy" } }] } });
  const resolved = await resolver.resolveProject(project, b);
  assert.equal(resolved.serviceId, b, "requested canonical service is selected without service ordering inference");
  assert.equal(resolved.logGroupName, revision(b, "API").runtimeIdentity.cloudWatchLogGroupName);
}

async function attributionAndHealth() {
  const logs: any = new CloudWatchLogsService(new ConfigService(), {} as never, new LogSanitizerService());
  assert.match(logs.safeError(new RuntimeIdentityUnavailableException("identity")), /runtime identity is unavailable/i);
  assert.match(logs.safeError(new AwsRuntimeUnavailableException("aws")), /ECS\/ALB runtime observation/i);
  assert.match(logs.safeError(new Error("logs")), /CloudWatch log streaming/i);

  const observability = new ObservabilityService(
    new ConfigService({ AWS_RUNTIME_MONITORING_ENABLED: "true", CLOUDWATCH_METRICS_ENABLED: "true", GRAFANA_BASE_URL: "https://grafana.example.test" }),
    { resolveForUser: async () => { throw new RuntimeIdentityUnavailableException("identity incomplete"); } } as never,
    {} as never, {} as never,
  );
  const metricResult: any = await observability.getApplicationMetrics({} as never, project.id);
  assert.equal(metricResult.availabilityState, "runtime_identity_unavailable");
  assert.deepEqual(metricResult.grafana, { configured: true, url: "https://grafana.example.test" }, "Grafana remains independent from CloudWatch/runtime resolution");

  const projected: any = {
    developerState: "live", developerMessage: "verified", progress: { percentage: 100, phase: null, label: "Live" }, latestAttempt: null,
    stableRelease: { promotedAt: new Date().toISOString(), runtimeIdentity: { region: "us-east-1", ecsClusterArn: arn("cluster/project"), services: [revision(a, "Web").runtimeIdentity] } },
    stableUrl: "https://web.example.test", estimatedCost: null, missingConfiguration: [], advisories: [], applicationError: null, canRetry: false,
  };
  const current: any = Object.create(ProjectCurrentStateService.prototype);
  current.config = new ConfigService({ AWS_RUNTIME_MONITORING_ENABLED: "true" });
  const state = current.withStateAuthority(project.id, "dev", projected, null, null);
  assert.equal(state.stateAuthority.applicationHealth.status, "unavailable", "deployment-time verification is not presented as current health without an AWS observation");
  assert.equal(state.stateAuthority.monitoring.available, false);
}

void Promise.all([canonicalRevisionRecovery(), attributionAndHealth()]).then(() => {
  console.log("LIVE_RUNTIME_CANONICAL_AUTHORITY=PASS");
}).catch((error) => { console.error(error); process.exitCode = 1; });
