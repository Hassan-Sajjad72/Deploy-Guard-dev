import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import {
  DescribeServicesCommand,
  DescribeTaskDefinitionCommand,
  RegisterTaskDefinitionCommand,
  UpdateServiceCommand,
} from "@aws-sdk/client-ecs";
import {
  DisabledV1EcsMutationClient,
  DisabledV1EcsMutationError,
  V1EcsRuntimeReferenceResolver,
} from "../src/orchestration-contracts/worker-runtime/disabled-v1-ecs-mutation.client";
import {
  V1EcsRegisterTaskDefinitionRevisionRequest,
  V1EcsUpdateExistingServiceRequest,
} from "../src/orchestration-contracts/worker-runtime/inactive-v1-ecs-release-mutation.types";
import {
  V1HandlerSideEffectExecutorContext,
} from "../src/orchestration-contracts/worker-runtime/v1-handler-side-effect.types";

const projectId = "11111111-1111-4111-8111-111111111111";
const releaseManifestId = "22222222-2222-4222-8222-222222222222";
const infrastructureManifestId =
  "33333333-3333-4333-8333-333333333333";
const configurationSnapshotId =
  "44444444-4444-4444-8444-444444444444";
const taskArn =
  "arn:aws:ecs:us-east-1:123456789012:task-definition/deployguard-app:7";
const registeredTaskArn =
  "arn:aws:ecs:us-east-1:123456789012:task-definition/deployguard-app:8";
const clusterArn =
  "arn:aws:ecs:us-east-1:123456789012:cluster/deployguard-project";
const serviceArn =
  "arn:aws:ecs:us-east-1:123456789012:service/deployguard-project/deployguard-app";
const digest = `sha256:${"a".repeat(64)}`;
const immutableImage =
  `123456789012.dkr.ecr.us-east-1.amazonaws.com/deployguard-app@${digest}`;
const secretArn =
  "arn:aws:secretsmanager:us-east-1:123456789012:secret:deployguard/jwt";

const registrationRequest: V1EcsRegisterTaskDefinitionRevisionRequest = {
  region: "us-east-1",
  sourceTaskDefinitionArn: taskArn,
  family: "deployguard-app",
  containerName: "app",
  immutableImage,
  command: "node dist/main.js",
  containerPort: 3000,
  cpu: 512,
  memory: 1024,
  logGroupName: "/deployguard/project/app",
  environmentReferences: [
    {
      name: "NODE_ENV",
      source: "configuration_snapshot",
      configurationSnapshotId,
    },
    {
      name: "JWT_SECRET",
      source: "secret_reference",
      configurationSnapshotId,
    },
  ],
  serviceBindingReferences: [],
  evidenceTags: {
    projectId,
    environmentName: "production",
    releaseManifestId,
    releaseRevision: "8",
    infrastructureManifestId,
    infrastructureRevision: "4",
    taskDefinitionInputHash: "b".repeat(64),
    imageDigest: digest,
  },
};

const serviceRequest: V1EcsUpdateExistingServiceRequest = {
  region: "us-east-1",
  clusterArn,
  serviceArn,
  taskDefinitionArn: registeredTaskArn,
  forceNewDeployment: true,
};

function sourceTask() {
  return {
    taskDefinitionArn: taskArn,
    family: "deployguard-app",
    revision: 7,
    status: "ACTIVE" as const,
    taskRoleArn:
      "arn:aws:iam::123456789012:role/deployguard-task-role",
    executionRoleArn:
      "arn:aws:iam::123456789012:role/deployguard-execution-role",
    networkMode: "awsvpc" as const,
    cpu: "256",
    memory: "512",
    requiresCompatibilities: ["FARGATE" as const],
    runtimePlatform: {
      cpuArchitecture: "X86_64" as const,
      operatingSystemFamily: "LINUX" as const,
    },
    ephemeralStorage: { sizeInGiB: 30 },
    volumes: [{
      name: "persistent-storage",
      efsVolumeConfiguration: {
        fileSystemId: "fs-12345678",
        transitEncryption: "ENABLED" as const,
        authorizationConfig: {
          accessPointId: "fsap-12345678",
          iam: "ENABLED" as const,
        },
      },
    }],
    placementConstraints: [],
    containerDefinitions: [
      {
        name: "app",
        image:
          "123456789012.dkr.ecr.us-east-1.amazonaws.com/deployguard-app:old",
        essential: true,
        readonlyRootFilesystem: true,
        mountPoints: [{
          sourceVolume: "persistent-storage",
          containerPath: "/data",
          readOnly: false,
        }],
        environment: [],
        secrets: [],
        portMappings: [{
          name: "http",
          containerPort: 8080,
          hostPort: 8080,
          protocol: "tcp" as const,
          appProtocol: "http",
        }],
        logConfiguration: {
          logDriver: "awslogs" as const,
          options: {
            "awslogs-group": "/deployguard/project/app",
            "awslogs-region": "us-east-1",
            "awslogs-stream-prefix": "ecs",
          },
        },
      },
      {
        name: "telemetry",
        image: "public.ecr.aws/aws-observability/aws-otel-collector:v0.40.0",
        essential: false,
        environment: [{ name: "MODE", value: "readonly" }],
        secrets: [],
        portMappings: [],
        logConfiguration: {
          logDriver: "awslogs" as const,
          options: {
            "awslogs-group": "/deployguard/project/app",
            "awslogs-region": "us-east-1",
            "awslogs-stream-prefix": "telemetry",
          },
        },
      },
    ],
  };
}

function ownership(
  signal = new AbortController().signal,
  trusted: () => boolean = () => true,
): V1HandlerSideEffectExecutorContext {
  return {
    intentId: "55555555-5555-4555-8555-555555555555",
    projectId,
    environmentName: "production",
    operationId: "66666666-6666-4666-8666-666666666666",
    idempotencyKey: "c".repeat(64),
    effectType: "ecs.register_task_definition_revision",
    inputFingerprint: "d".repeat(64),
    leaseId: "77777777-7777-4777-8777-777777777777",
    workerId: "worker-fixture",
    fencingToken: "9",
    signal,
    deadlineAt: new Date(Date.now() + 60_000),
    isLeaseTrusted: trusted,
  };
}

function resolver(
  override?: V1EcsRuntimeReferenceResolver["resolve"],
): V1EcsRuntimeReferenceResolver {
  return {
    policy:
      "deployguard.ecs-release-mutation/runtime-reference-resolver-v1",
    resolve: override ?? (async () => ({
      environment: [{ name: "NODE_ENV", value: "production" }],
      secrets: [{ name: "JWT_SECRET", valueFrom: secretArn }],
    })),
  };
}

async function expectCode(
  operation: () => Promise<unknown>,
  code: DisabledV1EcsMutationError["code"],
) {
  await assert.rejects(operation, (error: unknown) =>
    error instanceof DisabledV1EcsMutationError
    && error.code === code
    && error.message === code
  );
}

async function main() {
  const commands: unknown[] = [];
  let registerInput: RegisterTaskDefinitionCommand["input"] | null = null;
  let updateInput: UpdateServiceCommand["input"] | null = null;
  const client = {
    async send(command: unknown) {
      commands.push(command);
      if (command instanceof DescribeTaskDefinitionCommand) {
        return {
          taskDefinition: sourceTask(),
          tags: [
            { key: "managed-by", value: "terraform" },
            {
              key: "deployguard:release-manifest-id",
              value: "old-release",
            },
          ],
        };
      }
      if (command instanceof RegisterTaskDefinitionCommand) {
        registerInput = command.input;
        return {
          taskDefinition: {
            taskDefinitionArn: registeredTaskArn,
            family: command.input.family,
            revision: 8,
            status: "ACTIVE",
            cpu: command.input.cpu,
            memory: command.input.memory,
            containerDefinitions: command.input.containerDefinitions,
          },
          tags: command.input.tags,
        };
      }
      if (command instanceof DescribeServicesCommand) {
        return {
          services: [{
            clusterArn,
            serviceArn,
            status: "ACTIVE",
            taskDefinition: taskArn,
          }],
          failures: [],
        };
      }
      if (command instanceof UpdateServiceCommand) {
        updateInput = command.input;
        return {
          service: {
            clusterArn,
            serviceArn,
            status: "ACTIVE",
            taskDefinition: command.input.taskDefinition,
          },
        };
      }
      throw new Error("unexpected fixture command");
    },
  };
  const adapter = new DisabledV1EcsMutationClient(
    client as any,
    resolver(),
    { region: "us-east-1" },
  );

  const registered = await adapter.registerTaskDefinitionRevision(
    registrationRequest,
    ownership(),
  );
  assert.equal(registered.taskDefinitionArn, registeredTaskArn);
  assert.ok(registerInput);
  const input = registerInput!;
  assert.equal(input.taskRoleArn, sourceTask().taskRoleArn);
  assert.equal(input.executionRoleArn, sourceTask().executionRoleArn);
  assert.equal(input.networkMode, "awsvpc");
  assert.deepEqual(input.volumes, sourceTask().volumes);
  assert.deepEqual(
    input.requiresCompatibilities,
    sourceTask().requiresCompatibilities,
  );
  assert.deepEqual(input.runtimePlatform, sourceTask().runtimePlatform);
  assert.deepEqual(input.ephemeralStorage, sourceTask().ephemeralStorage);
  assert.equal(input.cpu, "512");
  assert.equal(input.memory, "1024");
  assert.equal(input.containerDefinitions?.length, 2);
  const app = input.containerDefinitions?.find((item) => item.name === "app")!;
  const telemetry = input.containerDefinitions?.find(
    (item) => item.name === "telemetry",
  )!;
  assert.equal(app.image, immutableImage);
  assert.deepEqual(app.command, ["sh", "-c", "node dist/main.js"]);
  assert.deepEqual(app.environment, [
    { name: "NODE_ENV", value: "production" },
  ]);
  assert.deepEqual(app.secrets, [
    { name: "JWT_SECRET", valueFrom: secretArn },
  ]);
  assert.deepEqual(app.portMappings, [{
    ...sourceTask().containerDefinitions[0].portMappings[0],
    containerPort: 3000,
    hostPort: 3000,
  }]);
  assert.deepEqual(
    app.logConfiguration,
    sourceTask().containerDefinitions[0].logConfiguration,
  );
  assert.deepEqual(telemetry, sourceTask().containerDefinitions[1]);
  const tagMap = new Map(
    input.tags?.map((tag) => [tag.key, tag.value]),
  );
  assert.equal(tagMap.get("managed-by"), "terraform");
  assert.equal(
    tagMap.get("deployguard:release-manifest-id"),
    releaseManifestId,
  );
  assert.equal(
    tagMap.get("deployguard:task-definition-input-hash"),
    "b".repeat(64),
  );
  assert.equal(tagMap.get("deployguard:image-digest"), digest);
  assert.equal(JSON.stringify(input).includes("raw-secret-value"), false);

  const updated = await adapter.updateExistingService(
    serviceRequest,
    ownership(),
  );
  assert.equal(updated.serviceArn, serviceArn);
  assert.deepEqual(updateInput, {
    cluster: clusterArn,
    service: serviceArn,
    taskDefinition: registeredTaskArn,
    forceNewDeployment: true,
  });
  assert.deepEqual(
    commands.map((command) => (command as object).constructor.name),
    [
      "DescribeTaskDefinitionCommand",
      "RegisterTaskDefinitionCommand",
      "DescribeServicesCommand",
      "UpdateServiceCommand",
    ],
  );

  let calls = 0;
  const countingClient = {
    async send() {
      calls += 1;
      return {};
    },
  };
  const rejected = new DisabledV1EcsMutationClient(
    countingClient as any,
    resolver(),
    { region: "us-east-1" },
  );
  await expectCode(
    () => rejected.registerTaskDefinitionRevision({
      ...registrationRequest,
      immutableImage:
        "123456789012.dkr.ecr.us-east-1.amazonaws.com/deployguard-app:latest",
    }, ownership()),
    "ECS_MUTATION_CONTRACT_INVALID",
  );
  assert.equal(calls, 0);

  await expectCode(
    () => rejected.registerTaskDefinitionRevision({
      ...registrationRequest,
      cpu: 256,
      memory: 4096,
    }, ownership()),
    "ECS_MUTATION_CONTRACT_INVALID",
  );
  assert.equal(calls, 0);

  const aborted = new AbortController();
  aborted.abort();
  await expectCode(
    () => rejected.registerTaskDefinitionRevision(
      registrationRequest,
      ownership(aborted.signal),
    ),
    "ECS_MUTATION_CANCELLED",
  );
  assert.equal(calls, 0);

  await expectCode(
    () => rejected.registerTaskDefinitionRevision(
      registrationRequest,
      ownership(new AbortController().signal, () => false),
    ),
    "ECS_MUTATION_OWNERSHIP_LOST",
  );
  assert.equal(calls, 0);

  const mismatched = new DisabledV1EcsMutationClient({
    async send(command: unknown) {
      if (command instanceof DescribeTaskDefinitionCommand) {
        return {
          taskDefinition: {
            ...sourceTask(),
            taskDefinitionArn:
              "arn:aws:ecs:us-east-1:123456789012:task-definition/other:7",
          },
          tags: [],
        };
      }
      return {};
    },
  } as any, resolver(), { region: "us-east-1" });
  await expectCode(
    () => mismatched.registerTaskDefinitionRevision(
      registrationRequest,
      ownership(),
    ),
    "ECS_MUTATION_SOURCE_DEFINITION_INVALID",
  );

  const plaintextSource = new DisabledV1EcsMutationClient({
    async send() {
      const source = sourceTask();
      source.containerDefinitions[1].environment = [{
        name: "API_TOKEN",
        value: "raw-secret-value",
      }];
      return { taskDefinition: source, tags: [] };
    },
  } as any, resolver(), { region: "us-east-1" });
  await expectCode(
    () => plaintextSource.registerTaskDefinitionRevision(
      registrationRequest,
      ownership(),
    ),
    "ECS_MUTATION_SOURCE_DEFINITION_INVALID",
  );

  const plaintextResolver = new DisabledV1EcsMutationClient({
    async send() {
      return { taskDefinition: sourceTask(), tags: [] };
    },
  } as any, resolver(async () => ({
    environment: [
      { name: "NODE_ENV", value: "production" },
      { name: "JWT_SECRET", value: "raw-secret-value" },
    ],
    secrets: [],
  })), { region: "us-east-1" });
  await expectCode(
    () => plaintextResolver.registerTaskDefinitionRevision(
      registrationRequest,
      ownership(),
    ),
    "ECS_MUTATION_REFERENCE_RESOLUTION_INVALID",
  );

  let trusted = true;
  let lostCalls = 0;
  const lost = new DisabledV1EcsMutationClient({
    async send(command: unknown) {
      lostCalls += 1;
      if (command instanceof DescribeTaskDefinitionCommand) {
        trusted = false;
        return { taskDefinition: sourceTask(), tags: [] };
      }
      throw new Error("mutation must not be reached");
    },
  } as any, resolver(), { region: "us-east-1" });
  await expectCode(
    () => lost.registerTaskDefinitionRevision(
      registrationRequest,
      ownership(new AbortController().signal, () => trusted),
    ),
    "ECS_MUTATION_OWNERSHIP_LOST",
  );
  assert.equal(lostCalls, 1);

  let updateCalls = 0;
  const wrongService = new DisabledV1EcsMutationClient({
    async send(command: unknown) {
      updateCalls += 1;
      if (command instanceof DescribeServicesCommand) {
        return {
          services: [{
            clusterArn,
            serviceArn:
              "arn:aws:ecs:us-east-1:123456789012:service/other",
            status: "ACTIVE",
          }],
        };
      }
      throw new Error("update must not be reached");
    },
  } as any, resolver(), { region: "us-east-1" });
  await expectCode(
    () => wrongService.updateExistingService(
      serviceRequest,
      ownership(),
    ),
    "ECS_MUTATION_IDENTITY_MISMATCH",
  );
  assert.equal(updateCalls, 1);

  const sdkFailure = new DisabledV1EcsMutationClient({
    async send() {
      throw new Error(
        "AccessDenied raw-token=raw-secret-value request-payload",
      );
    },
  } as any, resolver(), { region: "us-east-1" });
  await expectCode(
    () => sdkFailure.registerTaskDefinitionRevision(
      registrationRequest,
      ownership(),
    ),
    "ECS_MUTATION_RESULT_UNCERTAIN",
  );

  const source = readFileSync(
    "src/orchestration-contracts/worker-runtime/disabled-v1-ecs-mutation.client.ts",
    "utf8",
  );
  const moduleSource = readFileSync(
    "src/orchestration-contracts/orchestration-contracts.module.ts",
    "utf8",
  );
  assert.match(source, /DescribeTaskDefinitionCommand/);
  assert.match(source, /RegisterTaskDefinitionCommand/);
  assert.match(source, /DescribeServicesCommand/);
  assert.match(source, /UpdateServiceCommand/);
  assert.doesNotMatch(
    source,
    /CreateServiceCommand|CreateClusterCommand|DeleteServiceCommand|DeregisterTaskDefinitionCommand|Terraform|terraform/,
  );
  assert.doesNotMatch(
    source,
    /new ECSClient|OnModuleInit|OnApplicationBootstrap|@Injectable|@Controller|new Worker/,
  );
  assert.doesNotMatch(moduleSource, /DisabledV1EcsMutationClient/);

  console.log("Disabled v1 ECS mutation client verification passed");
}

void main();
