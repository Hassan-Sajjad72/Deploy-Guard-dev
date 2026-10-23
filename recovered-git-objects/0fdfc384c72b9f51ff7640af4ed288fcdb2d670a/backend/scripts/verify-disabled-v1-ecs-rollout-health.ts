import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import {
  DescribeServicesCommand,
  DescribeTaskDefinitionCommand,
  DescribeTasksCommand,
  ListTasksCommand,
} from "@aws-sdk/client-ecs";
import {
  DescribeTargetGroupsCommand,
  DescribeTargetHealthCommand,
} from "@aws-sdk/client-elastic-load-balancing-v2";
import { canonicalSha256 } from
  "../src/orchestration-contracts/contracts/canonical-json";
import {
  DisabledV1EcsRolloutHealthVerifier,
} from "../src/orchestration-contracts/worker-runtime/disabled-v1-ecs-rollout-health.verifier";
import {
  buildV1EcsReleaseMutationPlan,
} from "../src/orchestration-contracts/worker-runtime/inactive-v1-ecs-release-mutation.pure";
import {
  V1EcsReleaseManifestPair,
  V1EcsReleaseRevisionIdentity,
} from "../src/orchestration-contracts/worker-runtime/inactive-v1-ecs-release-mutation.types";
import {
  V1EcsRolloutHealthVerificationError,
} from "../src/orchestration-contracts/worker-runtime/inactive-v1-ecs-rollout-health.types";

const projectId = "11111111-1111-4111-8111-111111111111";
const infrastructureManifestId =
  "22222222-2222-4222-8222-222222222222";
const releaseManifestId = "33333333-3333-4333-8333-333333333333";
const configurationSnapshotId =
  "44444444-4444-4444-8444-444444444444";
const clusterArn =
  "arn:aws:ecs:us-east-1:123456789012:cluster/deployguard-project";
const serviceArn =
  "arn:aws:ecs:us-east-1:123456789012:service/deployguard-project/deployguard-app";
const baseTaskArn =
  "arn:aws:ecs:us-east-1:123456789012:task-definition/deployguard-app:7";
const candidateTaskDefinitionArn =
  "arn:aws:ecs:us-east-1:123456789012:task-definition/deployguard-app:8";
const oldTaskDefinitionArn =
  "arn:aws:ecs:us-east-1:123456789012:task-definition/deployguard-app:6";
const targetGroupArn =
  "arn:aws:elasticloadbalancing:us-east-1:123456789012:targetgroup/deployguard-app/abc123";
const imageDigest = `sha256:${"e".repeat(64)}`;
const candidateImage =
  `123456789012.dkr.ecr.us-east-1.amazonaws.com/deployguard-app@${imageDigest}`;
const candidateTaskArn =
  "arn:aws:ecs:us-east-1:123456789012:task/deployguard-project/candidate1";
const candidateTaskArn2 =
  "arn:aws:ecs:us-east-1:123456789012:task/deployguard-project/candidate2";
const oldTaskArn =
  "arn:aws:ecs:us-east-1:123456789012:task/deployguard-project/stale1";
const stoppedTaskArn =
  "arn:aws:ecs:us-east-1:123456789012:task/deployguard-project/stopped1";
const revision: V1EcsReleaseRevisionIdentity = {
  projectId,
  environmentName: "production",
  releaseManifestId,
  releaseRevision: "8",
  infrastructureManifestId,
  infrastructureRevision: "4",
};

function manifestPair(): V1EcsReleaseManifestPair {
  const desiredSpec = {
    region: "us-east-1",
    terraformTemplateVersion: "v1",
    network: {
      topology: "managed_vpc" as const,
      availabilityZoneCount: 2,
      publicSubnets: true,
      privateSubnets: true,
      natMode: "single" as const,
    },
    registry: {
      managedEcrRepository: true,
      immutableTags: true,
      lifecyclePolicyHash: null,
    },
    ecsFoundation: {
      clusterMode: "shared_project" as const,
      serviceName: "deployguard-app",
      launchType: "fargate" as const,
      capacityProviders: ["FARGATE"],
    },
    ingress: {
      enabled: true,
      protocol: "HTTP" as const,
      containerPort: 3000,
      targetGroupPort: 3000,
      healthCheckPath: "/api/health",
      healthCheckProtocol: "HTTP" as const,
    },
    database: {
      mode: "none" as const,
      engine: null,
      tierRevision: null,
      persistence: false,
      externalTlsRequired: null,
    },
    storage: {
      efsRequired: false,
      accessPointRequired: false,
      encrypted: true,
      backupRequired: false,
    },
    discovery: { cloudMapRequired: false, namespace: null },
    observability: {
      cloudWatchLogs: true,
      cloudWatchMetrics: true,
      prometheus: false,
    },
    iamPolicyRevision: "v1",
    tags: { managedBy: "DeployGuard" },
  };
  const releaseSpec = {
    source: {
      repositoryFullName: "example/web-app",
      branch: "main",
      commitSha: "b".repeat(40),
      appRoot: ".",
    },
    build: {
      dockerStrategy: "generated" as const,
      dockerTemplate: "node-server-v1",
      buildCommand: "npm run build",
      outputDirectory: null,
      buildArgumentNames: [],
    },
    runtime: {
      imageUri: null,
      imageDigest: null,
      command: "npm start",
      containerPort: 3000,
      cpu: 256,
      memory: 512,
      plainVariableNames: [],
      secretReferenceNames: [],
      serviceBindingRevisions: [],
    },
    health: {
      path: "/api/health",
      expectedPort: 3000,
      gracePeriodSeconds: 60,
    },
  };
  const terraformOutputs = {
    ecs_cluster_arn: clusterArn,
    ecs_service_arn: serviceArn,
    ecs_service_name: "deployguard-app",
    ecs_task_definition_arn: baseTaskArn,
    ecs_container_name: "app",
    ecs_log_group_name: "/deployguard/project/app",
    ecs_container_port: 3000,
    alb_target_group_arn: targetGroupArn,
  };
  const pair: V1EcsReleaseManifestPair = {
    infrastructure: {
      id: infrastructureManifestId,
      schemaVersion: 1,
      projectId,
      environmentName: "production",
      revision: "4",
      parentManifestId: null,
      createdByIntentId: null,
      createdByUserId: null,
      origin: "planner",
      status: "applied",
      specHash: canonicalSha256(desiredSpec),
      terraformTemplateVersion: "v1",
      stateBackend: "s3",
      stateKey: `projects/${projectId}/terraform.tfstate`,
      desiredSpec,
      changeSet: {
        fromManifestId: null,
        changedPaths: ["network"],
        categories: ["network"],
        destructivePaths: [],
        requiresApproval: true,
        reasonCodes: ["INITIAL_INFRASTRUCTURE"],
      },
      requiresTerraform: true,
      terraformOutputs,
      terraformOutputsHash: canonicalSha256(terraformOutputs),
    },
    release: {
      id: releaseManifestId,
      schemaVersion: 1,
      projectId,
      environmentName: "production",
      revision: "8",
      parentManifestId: null,
      previousStableManifestId: null,
      infrastructureManifestId,
      createdByIntentId: null,
      pipelineRunId: null,
      deploymentContractId: null,
      configurationSnapshotId,
      origin: "planner",
      status: "deploying",
      specHash: canonicalSha256(releaseSpec),
      repositoryFullName: releaseSpec.source.repositoryFullName,
      branch: releaseSpec.source.branch,
      commitSha: releaseSpec.source.commitSha,
      appRoot: releaseSpec.source.appRoot,
      deploymentContractHash: "a".repeat(64),
      configurationFingerprint: "a".repeat(64),
      buildFingerprint: "a".repeat(64),
      runtimeFingerprint: "a".repeat(64),
      releaseSpec,
      imageUri:
        "123456789012.dkr.ecr.us-east-1.amazonaws.com/deployguard-app:build-8",
      imageDigest,
      taskDefinitionInputHash: null,
      taskDefinitionArn: candidateTaskDefinitionArn,
    },
  };
  pair.release.taskDefinitionInputHash =
    buildV1EcsReleaseMutationPlan(revision, pair).taskDefinitionInputHash;
  return pair;
}

type Scenario = {
  rolloutState?: "COMPLETED" | "IN_PROGRESS" | "FAILED";
  desiredCount?: number;
  runningCount?: number;
  pendingCount?: number;
  runningTasks?: any[];
  stoppedTasks?: any[];
  targetStates?: Array<{ ip: string; state: string; port?: number }>;
  omitReleaseTag?: boolean;
  rawError?: boolean;
  afterRead?: () => void;
};

function runningTask(
  arn: string,
  taskDefinitionArn: string,
  ip: string,
) {
  return {
    taskArn: arn,
    clusterArn,
    group: "service:deployguard-app",
    taskDefinitionArn,
    desiredStatus: "RUNNING",
    lastStatus: "RUNNING",
    containers: [{
      name: "app",
      lastStatus: "RUNNING",
      networkInterfaces: [{ privateIpv4Address: ip }],
    }],
  };
}

function stoppedTask() {
  return {
    taskArn: stoppedTaskArn,
    clusterArn,
    group: "service:deployguard-app",
    taskDefinitionArn: candidateTaskDefinitionArn,
    desiredStatus: "STOPPED",
    lastStatus: "STOPPED",
    stopCode: "TaskFailedToStart",
    stoppedReason: "CannotPullContainerError raw-secret-value",
    containers: [{
      name: "app",
      lastStatus: "STOPPED",
      exitCode: 1,
      reason: "raw SDK diagnostic",
    }],
  };
}

function stoppedTaskWithReasonOnly() {
  return {
    ...stoppedTask(),
    stopCode: "UserInitiated",
    containers: [{
      name: "app",
      lastStatus: "STOPPED",
      exitCode: 0,
    }],
  };
}

function fixtureClients(pair: V1EcsReleaseManifestPair, scenario: Scenario) {
  const plan = buildV1EcsReleaseMutationPlan(revision, pair);
  const commands: string[] = [];
  const running = scenario.runningTasks ?? [
    runningTask(candidateTaskArn, candidateTaskDefinitionArn, "10.0.1.10"),
    runningTask(oldTaskArn, oldTaskDefinitionArn, "10.0.1.99"),
  ];
  const stopped = scenario.stoppedTasks ?? [];
  const tags = Object.entries({
    "deployguard:project-id": projectId,
    "deployguard:environment": "production",
    "deployguard:release-manifest-id": releaseManifestId,
    "deployguard:release-revision": "8",
    "deployguard:infrastructure-manifest-id": infrastructureManifestId,
    "deployguard:infrastructure-revision": "4",
    "deployguard:task-definition-input-hash":
      plan.taskDefinitionInputHash,
    "deployguard:image-digest": imageDigest,
  }).filter(([key]) =>
    !(scenario.omitReleaseTag
      && key === "deployguard:release-manifest-id")
  ).map(([key, value]) => ({ key, value }));
  const ecs = {
    async send(command: unknown) {
      commands.push((command as object).constructor.name);
      scenario.afterRead?.();
      if (scenario.rawError) {
        throw new Error("AccessDenied token=raw-secret-value payload");
      }
      if (command instanceof DescribeTaskDefinitionCommand) {
        assert.equal(
          command.input.taskDefinition,
          candidateTaskDefinitionArn,
        );
        return {
          taskDefinition: {
            taskDefinitionArn: candidateTaskDefinitionArn,
            family: "deployguard-app",
            revision: 8,
            status: "ACTIVE",
            containerDefinitions: [{
              name: "app",
              image: candidateImage,
              portMappings: [{
                containerPort: 3000,
                hostPort: 3000,
                protocol: "tcp",
              }],
            }],
          },
          tags,
        };
      }
      if (command instanceof DescribeServicesCommand) {
        assert.equal(command.input.cluster, clusterArn);
        assert.deepEqual(command.input.services, [serviceArn]);
        return {
          services: [{
            clusterArn,
            serviceArn,
            status: "ACTIVE",
            taskDefinition: candidateTaskDefinitionArn,
            desiredCount: scenario.desiredCount ?? 1,
            runningCount: scenario.runningCount ?? 1,
            pendingCount: scenario.pendingCount ?? 0,
            deployments: [{
              status: "PRIMARY",
              taskDefinition: candidateTaskDefinitionArn,
              rolloutState: scenario.rolloutState ?? "COMPLETED",
              desiredCount: scenario.desiredCount ?? 1,
              runningCount: scenario.runningCount ?? 1,
              pendingCount: scenario.pendingCount ?? 0,
            }, {
              status: "ACTIVE",
              taskDefinition: oldTaskDefinitionArn,
              rolloutState: "COMPLETED",
              desiredCount: 0,
              runningCount: 1,
              pendingCount: 0,
            }],
          }],
          failures: [],
        };
      }
      if (command instanceof ListTasksCommand) {
        assert.equal(command.input.cluster, clusterArn);
        assert.equal(command.input.serviceName, serviceArn);
        const tasks = command.input.desiredStatus === "STOPPED"
          ? stopped
          : running;
        return { taskArns: tasks.map((task) => task.taskArn) };
      }
      if (command instanceof DescribeTasksCommand) {
        assert.equal(command.input.cluster, clusterArn);
        const available = [...running, ...stopped];
        return {
          tasks: available.filter((task) =>
            command.input.tasks.includes(task.taskArn)
          ),
          failures: [],
        };
      }
      throw new Error("unexpected ECS command");
    },
  };
  const elbv2 = {
    async send(command: unknown) {
      commands.push((command as object).constructor.name);
      scenario.afterRead?.();
      if (scenario.rawError) {
        throw new Error("ELB raw-secret-value response");
      }
      if (command instanceof DescribeTargetGroupsCommand) {
        assert.deepEqual(command.input.TargetGroupArns, [targetGroupArn]);
        return {
          TargetGroups: [{
            TargetGroupArn: targetGroupArn,
            Port: 3000,
            Protocol: "HTTP",
            TargetType: "ip",
          }],
        };
      }
      if (command instanceof DescribeTargetHealthCommand) {
        assert.equal(command.input.TargetGroupArn, targetGroupArn);
        return {
          TargetHealthDescriptions: (
            scenario.targetStates ?? [
              { ip: "10.0.1.10", state: "healthy" },
              { ip: "10.0.1.99", state: "healthy" },
            ]
          ).map((target) => ({
            Target: { Id: target.ip, Port: target.port ?? 3000 },
            TargetHealth: { State: target.state },
          })),
        };
      }
      throw new Error("unexpected ELB command");
    },
  };
  return { ecs, elbv2, commands };
}

function verificationInput(
  pair: V1EcsReleaseManifestPair,
  trusted: () => boolean = () => true,
  signal = new AbortController().signal,
) {
  return {
    revision,
    manifests: { async loadExact() { return pair; } },
    execution: { signal, isLeaseTrusted: trusted },
    deadlineAt: new Date("2026-07-24T12:05:00.000Z"),
  };
}

async function runScenario(
  scenario: Scenario,
  now = new Date("2026-07-24T12:00:00.000Z"),
) {
  const pair = manifestPair();
  const fixtures = fixtureClients(pair, scenario);
  const verifier = new DisabledV1EcsRolloutHealthVerifier(
    fixtures.ecs as any,
    fixtures.elbv2 as any,
    { region: "us-east-1", now: () => now },
  );
  return {
    result: await verifier.verify(verificationInput(pair)),
    commands: fixtures.commands,
  };
}

async function main() {
  const healthy = await runScenario({});
  assert.deepEqual(healthy.result, {
    status: "healthy",
    safeCode: "ECS_ROLLOUT_AND_TARGETS_HEALTHY",
    evidenceHash: healthy.result.evidenceHash,
  });
  assert.match(healthy.result.evidenceHash, /^[0-9a-f]{64}$/);
  assert.deepEqual(healthy.commands, [
    "DescribeTaskDefinitionCommand",
    "DescribeServicesCommand",
    "ListTasksCommand",
    "ListTasksCommand",
    "DescribeTasksCommand",
    "DescribeTargetGroupsCommand",
    "DescribeTargetHealthCommand",
  ]);

  const progressing = await runScenario({
    rolloutState: "IN_PROGRESS",
    desiredCount: 2,
    runningCount: 1,
    pendingCount: 1,
    runningTasks: [
      runningTask(candidateTaskArn, candidateTaskDefinitionArn, "10.0.1.10"),
    ],
    targetStates: [{ ip: "10.0.1.10", state: "initial" }],
  });
  assert.equal(progressing.result.status, "progressing");
  assert.equal(progressing.result.safeCode, "ECS_ROLLOUT_PROGRESSING");

  const targetProgress = await runScenario({
    targetStates: [{ ip: "10.0.1.10", state: "initial" }],
  });
  assert.equal(targetProgress.result.status, "progressing");
  assert.equal(targetProgress.result.safeCode, "ECS_TARGETS_REGISTERING");

  const timedOut = await runScenario({
    rolloutState: "IN_PROGRESS",
    desiredCount: 2,
    runningCount: 1,
    pendingCount: 1,
    runningTasks: [
      runningTask(candidateTaskArn, candidateTaskDefinitionArn, "10.0.1.10"),
    ],
    targetStates: [{ ip: "10.0.1.10", state: "initial" }],
  }, new Date("2026-07-24T12:06:00.000Z"));
  assert.equal(timedOut.result.status, "timed_out");
  assert.equal(timedOut.result.safeCode, "ECS_ROLLOUT_HEALTH_TIMEOUT");

  const rolloutFailed = await runScenario({ rolloutState: "FAILED" });
  assert.equal(rolloutFailed.result.status, "failed");
  assert.equal(rolloutFailed.result.safeCode, "ECS_ROLLOUT_FAILED");

  const taskFailed = await runScenario({
    rolloutState: "IN_PROGRESS",
    desiredCount: 1,
    runningCount: 0,
    pendingCount: 0,
    runningTasks: [],
    stoppedTasks: [stoppedTask()],
    targetStates: [],
  });
  assert.equal(taskFailed.result.status, "failed");
  assert.equal(taskFailed.result.safeCode, "ECS_TASK_START_FAILED");
  assert.equal(JSON.stringify(taskFailed.result).includes("raw-secret"), false);

  const reasonFailed = await runScenario({
    rolloutState: "IN_PROGRESS",
    desiredCount: 1,
    runningCount: 0,
    pendingCount: 0,
    runningTasks: [],
    stoppedTasks: [stoppedTaskWithReasonOnly()],
    targetStates: [],
  });
  assert.equal(reasonFailed.result.status, "failed");
  assert.equal(reasonFailed.result.safeCode, "ECS_TASK_START_FAILED");

  const targetFailed = await runScenario({
    targetStates: [{ ip: "10.0.1.10", state: "unhealthy" }],
  });
  assert.equal(targetFailed.result.status, "failed");
  assert.equal(targetFailed.result.safeCode, "ALB_TARGET_UNHEALTHY");

  const wrongPort = await runScenario({
    targetStates: [{ ip: "10.0.1.10", state: "healthy", port: 8080 }],
  });
  assert.equal(wrongPort.result.status, "ambiguous");
  assert.equal(
    wrongPort.result.safeCode,
    "ECS_ROLLOUT_EVIDENCE_AMBIGUOUS",
  );

  const staleOnly = await runScenario({
    rolloutState: "IN_PROGRESS",
    desiredCount: 1,
    runningCount: 0,
    pendingCount: 1,
    runningTasks: [
      runningTask(oldTaskArn, oldTaskDefinitionArn, "10.0.1.99"),
    ],
    targetStates: [{ ip: "10.0.1.99", state: "healthy" }],
  });
  assert.equal(staleOnly.result.status, "progressing");
  assert.notEqual(staleOnly.result.status, "healthy");

  const malformed = await runScenario({ omitReleaseTag: true });
  assert.equal(malformed.result.status, "ambiguous");
  assert.equal(
    malformed.result.safeCode,
    "ECS_ROLLOUT_EVIDENCE_AMBIGUOUS",
  );

  const rawFailure = await runScenario({ rawError: true });
  assert.equal(rawFailure.result.status, "ambiguous");
  assert.equal(JSON.stringify(rawFailure.result).includes("AccessDenied"), false);
  assert.equal(JSON.stringify(rawFailure.result).includes("raw-secret"), false);

  const pair = manifestPair();
  let calls = 0;
  const noRead = {
    async send() {
      calls += 1;
      return {};
    },
  };
  const verifier = new DisabledV1EcsRolloutHealthVerifier(
    noRead as any,
    noRead as any,
    {
      region: "us-east-1",
      now: () => new Date("2026-07-24T12:00:00.000Z"),
    },
  );
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => verifier.verify(verificationInput(
      pair,
      () => true,
      controller.signal,
    )),
    (error: unknown) =>
      error instanceof V1EcsRolloutHealthVerificationError
      && error.code === "ECS_ROLLOUT_HEALTH_CANCELLED",
  );
  assert.equal(calls, 0);

  let trusted = true;
  const lostFixtures = fixtureClients(pair, {
    afterRead() { trusted = false; },
  });
  const lostVerifier = new DisabledV1EcsRolloutHealthVerifier(
    lostFixtures.ecs as any,
    lostFixtures.elbv2 as any,
    {
      region: "us-east-1",
      now: () => new Date("2026-07-24T12:00:00.000Z"),
    },
  );
  await assert.rejects(
    () => lostVerifier.verify(verificationInput(pair, () => trusted)),
    (error: unknown) =>
      error instanceof V1EcsRolloutHealthVerificationError
      && error.code === "ECS_ROLLOUT_HEALTH_OWNERSHIP_LOST",
  );
  assert.deepEqual(lostFixtures.commands, [
    "DescribeTaskDefinitionCommand",
  ]);

  const mismatchPair = manifestPair();
  mismatchPair.release.taskDefinitionInputHash = "f".repeat(64);
  const mismatchFixtures = fixtureClients(mismatchPair, {});
  const mismatchVerifier = new DisabledV1EcsRolloutHealthVerifier(
    mismatchFixtures.ecs as any,
    mismatchFixtures.elbv2 as any,
    {
      region: "us-east-1",
      now: () => new Date("2026-07-24T12:00:00.000Z"),
    },
  );
  const mismatch = await mismatchVerifier.verify(
    verificationInput(mismatchPair),
  );
  assert.equal(mismatch.status, "ambiguous");
  assert.equal(mismatchFixtures.commands.length, 0);

  const revisionPair = manifestPair();
  const revisionFixtures = fixtureClients(revisionPair, {});
  const revisionVerifier = new DisabledV1EcsRolloutHealthVerifier(
    revisionFixtures.ecs as any,
    revisionFixtures.elbv2 as any,
    {
      region: "us-east-1",
      now: () => new Date("2026-07-24T12:00:00.000Z"),
    },
  );
  const wrongRevisionInput = verificationInput(revisionPair);
  wrongRevisionInput.revision = {
    ...wrongRevisionInput.revision,
    releaseRevision: "9",
  };
  const wrongRevision = await revisionVerifier.verify(wrongRevisionInput);
  assert.equal(wrongRevision.status, "ambiguous");
  assert.equal(revisionFixtures.commands.length, 0);

  const source = readFileSync(
    "src/orchestration-contracts/worker-runtime/disabled-v1-ecs-rollout-health.verifier.ts",
    "utf8",
  );
  const moduleSource = readFileSync(
    "src/orchestration-contracts/orchestration-contracts.module.ts",
    "utf8",
  );
  assert.match(source, /DescribeTaskDefinitionCommand/);
  assert.match(source, /DescribeServicesCommand/);
  assert.match(source, /ListTasksCommand/);
  assert.match(source, /DescribeTasksCommand/);
  assert.match(source, /DescribeTargetGroupsCommand/);
  assert.match(source, /DescribeTargetHealthCommand/);
  assert.doesNotMatch(
    source,
    /RegisterTaskDefinitionCommand|UpdateServiceCommand|CreateServiceCommand|DeleteServiceCommand|RegisterTargetsCommand|DeregisterTargetsCommand|ModifyTargetGroupCommand|TerraformService|TerraformRunner/,
  );
  assert.doesNotMatch(
    source,
    /new ECSClient|new ElasticLoadBalancingV2Client|@Injectable|@Controller|OnModuleInit|OnApplicationBootstrap|new Worker/,
  );
  assert.doesNotMatch(
    moduleSource,
    /DisabledV1EcsRolloutHealthVerifier/,
  );

  console.log("Disabled v1 ECS rollout and health verification passed");
}

void main();
