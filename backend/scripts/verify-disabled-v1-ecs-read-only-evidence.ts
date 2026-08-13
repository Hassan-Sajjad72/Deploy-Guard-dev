import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import {
  DescribeServicesCommand,
  DescribeTaskDefinitionCommand,
  ECSClient,
  ListTaskDefinitionsCommand,
} from "@aws-sdk/client-ecs";
import {
  DisabledV1EcsReadOnlyEvidenceClient,
  V1_ECS_RELEASE_EVIDENCE_TAGS,
} from "../src/orchestration-contracts/worker-runtime/disabled-v1-ecs-read-only-evidence.client";
import {
  classifyV1EcsServiceUpdateEvidence,
  classifyV1EcsTaskDefinitionEvidence,
} from "../src/orchestration-contracts/worker-runtime/inactive-v1-ecs-release-reconciliation.pure";
import {
  V1EcsServiceUpdateEvidenceQuery,
  V1EcsTaskDefinitionEvidenceQuery,
} from "../src/orchestration-contracts/worker-runtime/inactive-v1-ecs-release-reconciliation.types";

const projectId = "11111111-1111-4111-8111-111111111111";
const releaseManifestId = "22222222-2222-4222-8222-222222222222";
const infrastructureManifestId =
  "33333333-3333-4333-8333-333333333333";
const imageDigest = `sha256:${"a".repeat(64)}`;
const taskDefinitionInputHash = "b".repeat(64);
const serviceUpdateInputHash = "c".repeat(64);
const immutableImage =
  "123456789012.dkr.ecr.us-east-1.amazonaws.com/"
  + `deployguard-app@${imageDigest}`;
const taskArn =
  "arn:aws:ecs:us-east-1:123456789012:"
  + "task-definition/deployguard-app:8";
const otherTaskArn =
  "arn:aws:ecs:us-east-1:123456789012:"
  + "task-definition/deployguard-app:7";
const clusterArn =
  "arn:aws:ecs:us-east-1:123456789012:cluster/deployguard-project";
const serviceArn =
  "arn:aws:ecs:us-east-1:123456789012:"
  + "service/deployguard-project/deployguard-app";

const taskQuery: V1EcsTaskDefinitionEvidenceQuery = {
  region: "us-east-1",
  family: "deployguard-app",
  containerName: "app",
  projectId,
  environmentName: "production",
  releaseManifestId,
  releaseRevision: "8",
  infrastructureManifestId,
  infrastructureRevision: "4",
  taskDefinitionInputHash,
  expectedTaskDefinitionArn: null,
  immutableImage,
  imageDigest,
};

const serviceQuery: V1EcsServiceUpdateEvidenceQuery = {
  ...taskQuery,
  expectedTaskDefinitionArn: taskArn,
  clusterArn,
  serviceArn,
  taskDefinitionArn: taskArn,
  serviceUpdateInputHash,
};

type Handler = (command: unknown) => Promise<unknown> | unknown;

function injectedClient(handler: Handler) {
  return {
    send(command: unknown) {
      return Promise.resolve(handler(command));
    },
  } as unknown as Pick<ECSClient, "send">;
}

function reader(
  handler: Handler,
  overrides: Record<string, unknown> = {},
) {
  return new DisabledV1EcsReadOnlyEvidenceClient(
    injectedClient(handler),
    {
      region: "us-east-1",
      baseRetryDelayMs: 1,
      sleep: async () => undefined,
      ...overrides,
    },
  );
}

function tags(overrides: Record<string, string> = {}) {
  const values = {
    [V1_ECS_RELEASE_EVIDENCE_TAGS.projectId]: projectId,
    [V1_ECS_RELEASE_EVIDENCE_TAGS.environmentName]: "production",
    [V1_ECS_RELEASE_EVIDENCE_TAGS.releaseManifestId]: releaseManifestId,
    [V1_ECS_RELEASE_EVIDENCE_TAGS.releaseRevision]: "8",
    [V1_ECS_RELEASE_EVIDENCE_TAGS.infrastructureManifestId]:
      infrastructureManifestId,
    [V1_ECS_RELEASE_EVIDENCE_TAGS.infrastructureRevision]: "4",
    [V1_ECS_RELEASE_EVIDENCE_TAGS.taskDefinitionInputHash]:
      taskDefinitionInputHash,
    [V1_ECS_RELEASE_EVIDENCE_TAGS.imageDigest]: imageDigest,
    ...overrides,
  };
  return Object.entries(values).map(([key, value]) => ({ key, value }));
}

function taskDescription(
  arn = taskArn,
  overrides: Record<string, unknown> = {},
) {
  return {
    taskDefinition: {
      taskDefinitionArn: arn,
      family: "deployguard-app",
      status: "ACTIVE",
      containerDefinitions: [{
        name: "app",
        image: immutableImage,
        environment: [{
          name: "IGNORED_REFERENCE",
          value: "must-not-be-exposed",
        }],
      }],
      executionRoleArn:
        "arn:aws:iam::123456789012:role/must-not-be-exposed",
      ...overrides,
    },
    tags: tags(),
    rawCredential: "must-not-be-exposed",
  };
}

function assertNoRawFields(value: unknown) {
  const serialized = JSON.stringify(value);
  assert.doesNotMatch(
    serialized,
    /must-not-be-exposed|executionRoleArn|rawCredential|AccessKey/i,
  );
}

async function run() {
  const listCalls: Array<Record<string, unknown>> = [];
  const paginated = reader((command) => {
    if (command instanceof ListTaskDefinitionsCommand) {
      listCalls.push(command.input as Record<string, unknown>);
      if (command.input.status === "INACTIVE") {
        return { taskDefinitionArns: [] };
      }
      if (!command.input.nextToken) {
        return {
          taskDefinitionArns: [otherTaskArn],
          nextToken: "page-2",
        };
      }
      return { taskDefinitionArns: [taskArn] };
    }
    if (command instanceof DescribeTaskDefinitionCommand) {
      assert.deepEqual(command.input.include, ["TAGS"]);
      if (command.input.taskDefinition === otherTaskArn) {
        return {
          ...taskDescription(otherTaskArn, {
            containerDefinitions: [{
              name: "app",
              image:
                "123456789012.dkr.ecr.us-east-1.amazonaws.com/"
                + `deployguard-app@sha256:${"f".repeat(64)}`,
            }],
          }),
          tags: tags({
            [V1_ECS_RELEASE_EVIDENCE_TAGS.releaseManifestId]:
              "99999999-9999-4999-8999-999999999999",
            [V1_ECS_RELEASE_EVIDENCE_TAGS.taskDefinitionInputHash]:
              "f".repeat(64),
            [V1_ECS_RELEASE_EVIDENCE_TAGS.imageDigest]:
              `sha256:${"f".repeat(64)}`,
          }),
        };
      }
      return taskDescription();
    }
    throw new Error("unexpected command");
  });
  const taskEvidence = await paginated.findTaskDefinitionEvidence(
    taskQuery,
    new AbortController().signal,
  );
  assert.equal(
    classifyV1EcsTaskDefinitionEvidence(
      taskQuery,
      taskEvidence,
    ).classification,
    "succeeded",
  );
  assert.equal(listCalls.length, 3);
  assert.deepEqual(listCalls[0], {
    familyPrefix: "deployguard-app",
    status: "ACTIVE",
    sort: "DESC",
    maxResults: 100,
    nextToken: undefined,
  });
  assert.equal(listCalls[1].nextToken, "page-2");
  assertNoRawFields(taskEvidence);

  const directInactiveQuery = {
    ...taskQuery,
    expectedTaskDefinitionArn: taskArn,
  };
  const inactive = reader((command) => {
    assert.ok(command instanceof DescribeTaskDefinitionCommand);
    return {
      ...taskDescription(),
      taskDefinition: {
        ...taskDescription().taskDefinition,
        status: "INACTIVE",
      },
    };
  });
  assert.equal(
    classifyV1EcsTaskDefinitionEvidence(
      directInactiveQuery,
      await inactive.findTaskDefinitionEvidence(
        directInactiveQuery,
        new AbortController().signal,
      ),
    ).classification,
    "failed",
  );

  const missing = reader((command) => {
    if (command instanceof DescribeTaskDefinitionCommand) {
      throw Object.assign(new Error("raw missing detail"), {
        name: "ClientException",
      });
    }
    throw new Error("unexpected command");
  });
  assert.equal(
    classifyV1EcsTaskDefinitionEvidence(
      directInactiveQuery,
      await missing.findTaskDefinitionEvidence(
        directInactiveQuery,
        new AbortController().signal,
      ),
    ).classification,
    "pending",
  );

  const duplicate = reader((command) => {
    if (command instanceof ListTaskDefinitionsCommand) {
      return command.input.status === "ACTIVE"
        ? { taskDefinitionArns: [taskArn, otherTaskArn] }
        : { taskDefinitionArns: [] };
    }
    if (command instanceof DescribeTaskDefinitionCommand) {
      return taskDescription(command.input.taskDefinition);
    }
    throw new Error("unexpected command");
  });
  assert.equal(
    classifyV1EcsTaskDefinitionEvidence(
      taskQuery,
      await duplicate.findTaskDefinitionEvidence(
        taskQuery,
        new AbortController().signal,
      ),
    ).classification,
    "manual_review",
  );

  const identityMismatch = reader((command) => {
    assert.ok(command instanceof DescribeTaskDefinitionCommand);
    return {
      ...taskDescription(),
      tags: tags({
        [V1_ECS_RELEASE_EVIDENCE_TAGS.projectId]:
          "99999999-9999-4999-8999-999999999999",
      }),
    };
  });
  assert.equal(
    classifyV1EcsTaskDefinitionEvidence(
      directInactiveQuery,
      await identityMismatch.findTaskDefinitionEvidence(
        directInactiveQuery,
        new AbortController().signal,
      ),
    ).classification,
    "manual_review",
  );

  const malformed = reader((command) => {
    assert.ok(command instanceof DescribeTaskDefinitionCommand);
    return {
      ...taskDescription(),
      taskDefinition: {
        ...taskDescription().taskDefinition,
        containerDefinitions: [],
      },
    };
  });
  assert.equal(
    classifyV1EcsTaskDefinitionEvidence(
      directInactiveQuery,
      await malformed.findTaskDefinitionEvidence(
        directInactiveQuery,
        new AbortController().signal,
      ),
    ).classification,
    "manual_review",
  );

  let throttleAttempts = 0;
  const retryDelays: number[] = [];
  const throttled = new DisabledV1EcsReadOnlyEvidenceClient(
    injectedClient((command) => {
      if (!(command instanceof DescribeTaskDefinitionCommand)) {
        throw new Error("unexpected command");
      }
      throttleAttempts += 1;
      if (throttleAttempts < 3) {
        throw Object.assign(new Error("AccessKey=must-not-be-exposed"), {
          name: "ThrottlingException",
          $metadata: { httpStatusCode: 429 },
        });
      }
      return taskDescription();
    }),
    {
      region: "us-east-1",
      maxAttempts: 3,
      baseRetryDelayMs: 2,
      sleep: async (milliseconds) => {
        retryDelays.push(milliseconds);
      },
    },
  );
  const throttledEvidence = await throttled.findTaskDefinitionEvidence(
    directInactiveQuery,
    new AbortController().signal,
  );
  assert.equal(throttleAttempts, 3);
  assert.deepEqual(retryDelays, [2, 4]);
  assert.equal(
    classifyV1EcsTaskDefinitionEvidence(
      directInactiveQuery,
      throttledEvidence,
    ).classification,
    "succeeded",
  );
  assertNoRawFields(throttledEvidence);

  let exhaustedAttempts = 0;
  const exhausted = reader((command) => {
    assert.ok(command instanceof DescribeTaskDefinitionCommand);
    exhaustedAttempts += 1;
    throw Object.assign(new Error("AccessKey=must-not-be-exposed"), {
      name: "ThrottlingException",
    });
  });
  const exhaustedEvidence = await exhausted.findTaskDefinitionEvidence(
    directInactiveQuery,
    new AbortController().signal,
  );
  assert.equal(exhaustedAttempts, 3);
  assert.equal(
    classifyV1EcsTaskDefinitionEvidence(
      directInactiveQuery,
      exhaustedEvidence,
    ).classification,
    "pending",
  );
  assertNoRawFields(exhaustedEvidence);

  const badPagination = reader((command) => {
    if (command instanceof ListTaskDefinitionsCommand) {
      return {
        taskDefinitionArns: [],
        nextToken: "same-token",
      };
    }
    throw new Error("unexpected command");
  });
  const badPageEvidence =
    await badPagination.findTaskDefinitionEvidence(
      taskQuery,
      new AbortController().signal,
    );
  assert.equal(
    classifyV1EcsTaskDefinitionEvidence(
      taskQuery,
      badPageEvidence,
    ).classification,
    "manual_review",
  );
  assertNoRawFields(badPageEvidence);

  function serviceReader(
    serviceOverrides: Record<string, unknown> = {},
    taskOverrides: Record<string, unknown> = {},
    taskTagOverrides: Record<string, string> = {},
  ) {
    return reader((command) => {
      if (command instanceof DescribeServicesCommand) {
        assert.equal(command.input.cluster, clusterArn);
        assert.deepEqual(command.input.services, [serviceArn]);
        return {
          services: [{
            serviceArn,
            clusterArn,
            status: "ACTIVE",
            taskDefinition: taskArn,
            deployments: [{
              status: "PRIMARY",
              taskDefinition: taskArn,
              rolloutState: "COMPLETED",
            }],
            events: [{ message: "must-not-be-exposed" }],
            ...serviceOverrides,
          }],
        };
      }
      if (command instanceof DescribeTaskDefinitionCommand) {
        return {
          ...taskDescription(taskArn, taskOverrides),
          tags: tags(taskTagOverrides),
        };
      }
      throw new Error("unexpected command");
    });
  }

  const serviceEvidence =
    await serviceReader().findServiceUpdateEvidence(
      serviceQuery,
      new AbortController().signal,
    );
  assert.equal(
    classifyV1EcsServiceUpdateEvidence(
      serviceQuery,
      serviceEvidence,
    ).classification,
    "succeeded",
  );
  assertNoRawFields(serviceEvidence);

  const serviceMissing = reader((command) => {
    assert.ok(command instanceof DescribeServicesCommand);
    return { services: [], failures: [{ reason: "MISSING" }] };
  });
  assert.equal(
    classifyV1EcsServiceUpdateEvidence(
      serviceQuery,
      await serviceMissing.findServiceUpdateEvidence(
        serviceQuery,
        new AbortController().signal,
      ),
    ).classification,
    "pending",
  );

  for (const serviceOverrides of [
    { status: "INACTIVE" },
    {
      deployments: [{
        status: "PRIMARY",
        taskDefinition: taskArn,
        rolloutState: "FAILED",
        rolloutStateReason: "must-not-be-exposed",
      }],
    },
  ]) {
    const evidence = await serviceReader(serviceOverrides)
      .findServiceUpdateEvidence(
        serviceQuery,
        new AbortController().signal,
      );
    assert.equal(
      classifyV1EcsServiceUpdateEvidence(
        serviceQuery,
        evidence,
      ).classification,
      "failed",
    );
    assertNoRawFields(evidence);
  }
  const inactiveServiceTask = await serviceReader(
    {},
    { status: "INACTIVE" },
  ).findServiceUpdateEvidence(
    serviceQuery,
    new AbortController().signal,
  );
  assert.equal(
    classifyV1EcsServiceUpdateEvidence(
      serviceQuery,
      inactiveServiceTask,
    ).classification,
    "failed",
  );

  const servicePending = await serviceReader({
    taskDefinition: otherTaskArn,
    deployments: [{
      status: "PRIMARY",
      taskDefinition: otherTaskArn,
      rolloutState: "COMPLETED",
    }],
  }).findServiceUpdateEvidence(
    serviceQuery,
    new AbortController().signal,
  );
  assert.equal(
    classifyV1EcsServiceUpdateEvidence(
      serviceQuery,
      servicePending,
    ).classification,
    "pending",
  );

  const duplicateDeployments = await serviceReader({
    deployments: [
      {
        status: "PRIMARY",
        taskDefinition: taskArn,
        rolloutState: "COMPLETED",
      },
      {
        status: "ACTIVE",
        taskDefinition: taskArn,
        rolloutState: "IN_PROGRESS",
      },
    ],
  }).findServiceUpdateEvidence(
    serviceQuery,
    new AbortController().signal,
  );
  assert.equal(
    classifyV1EcsServiceUpdateEvidence(
      serviceQuery,
      duplicateDeployments,
    ).classification,
    "manual_review",
  );

  const wrongServiceIdentity = await serviceReader({
    clusterArn:
      "arn:aws:ecs:us-east-1:123456789012:cluster/other-project",
  }).findServiceUpdateEvidence(
    serviceQuery,
    new AbortController().signal,
  );
  assert.equal(
    classifyV1EcsServiceUpdateEvidence(
      serviceQuery,
      wrongServiceIdentity,
    ).classification,
    "manual_review",
  );

  const wrongReleaseIdentity = await serviceReader(
    {},
    {},
    {
      [V1_ECS_RELEASE_EVIDENCE_TAGS.releaseRevision]: "9",
    },
  ).findServiceUpdateEvidence(
    serviceQuery,
    new AbortController().signal,
  );
  assert.equal(
    classifyV1EcsServiceUpdateEvidence(
      serviceQuery,
      wrongReleaseIdentity,
    ).classification,
    "manual_review",
  );

  const malformedService = await serviceReader({
    deployments: undefined,
  }).findServiceUpdateEvidence(
    serviceQuery,
    new AbortController().signal,
  );
  assert.equal(
    classifyV1EcsServiceUpdateEvidence(
      serviceQuery,
      malformedService,
    ).classification,
    "manual_review",
  );
  assertNoRawFields(malformedService);

  const rawFailure = reader((command) => {
    assert.ok(command instanceof DescribeServicesCommand);
    throw Object.assign(
      new Error("AccessKey=must-not-be-exposed SDK payload"),
      { name: "AccessDeniedException" },
    );
  });
  const rawFailureEvidence =
    await rawFailure.findServiceUpdateEvidence(
      serviceQuery,
      new AbortController().signal,
    );
  assert.equal(
    classifyV1EcsServiceUpdateEvidence(
      serviceQuery,
      rawFailureEvidence,
    ).classification,
    "manual_review",
  );
  assertNoRawFields(rawFailureEvidence);

  let malformedQueryCalls = 0;
  const malformedQueryReader = reader(() => {
    malformedQueryCalls += 1;
    return {};
  });
  const malformedQuery = {
    ...taskQuery,
    family: "../unsafe",
  };
  assert.equal(
    classifyV1EcsTaskDefinitionEvidence(
      malformedQuery,
      await malformedQueryReader.findTaskDefinitionEvidence(
        malformedQuery,
        new AbortController().signal,
      ),
    ).classification,
    "manual_review",
  );
  assert.equal(malformedQueryCalls, 0);

  const source = readFileSync(
    "src/orchestration-contracts/worker-runtime/"
      + "disabled-v1-ecs-read-only-evidence.client.ts",
    "utf8",
  );
  const moduleSource = readFileSync(
    "src/orchestration-contracts/orchestration-contracts.module.ts",
    "utf8",
  );
  assert.match(source, /ListTaskDefinitionsCommand/);
  assert.match(source, /DescribeTaskDefinitionCommand/);
  assert.match(source, /DescribeServicesCommand/);
  assert.doesNotMatch(
    source,
    /RegisterTaskDefinitionCommand|UpdateServiceCommand|DeleteServiceCommand|DeregisterTaskDefinitionCommand/,
  );
  assert.doesNotMatch(
    source,
    /Terraform|promot|rollback|OnModuleInit|OnApplicationBootstrap|@Controller|new Worker/i,
  );
  assert.doesNotMatch(
    moduleSource,
    /DisabledV1EcsReadOnlyEvidenceClient/,
  );

  console.log(
    "Disabled v1 ECS read-only evidence adapter verification passed",
  );
}

void run();
