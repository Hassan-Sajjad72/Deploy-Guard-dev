import { strict as assert } from "node:assert";
import { ConfigService } from "@nestjs/config";
import {
  LocalV1ReleaseFixtureAdapterFactory,
} from "../src/orchestration-contracts/release-lane/local-v1-release-fixture-adapter.factory";

const projectId = "11111111-1111-4111-8111-111111111111";
const configuration = {
  workerId: "local-fixture-release-worker",
  projectAllowlist: [projectId],
  environmentAllowlist: ["dev"],
} as const;

function factory(overrides: Record<string, unknown> = {}) {
  return new LocalV1ReleaseFixtureAdapterFactory(new ConfigService({
    NODE_ENV: "test",
    TWO_LANE_RELEASE_COMPOSITION_MODE: "fixture",
    TWO_LANE_LOCAL_RELEASE_FIXTURE_EXECUTION_ENABLED: "true",
    ...overrides,
  }));
}

function ownership() {
  return {
    signal: new AbortController().signal,
    deadlineAt: new Date(Date.now() + 60_000),
    isLeaseTrusted: () => true,
    intentId: "22222222-2222-4222-8222-222222222222",
    projectId,
    environmentName: "dev",
    operationId: "33333333-3333-4333-8333-333333333333",
    idempotencyKey: "a".repeat(64),
    effectType: "fixture.validation",
    inputFingerprint: "b".repeat(64),
    leaseId: "44444444-4444-4444-8444-444444444444",
    workerId: "local-fixture-release-worker",
    fencingToken: "1",
  };
}

async function run() {
  for (const invalid of [
    { NODE_ENV: "production" },
    { NODE_ENV: "development" },
    { TWO_LANE_LOCAL_RELEASE_FIXTURE_EXECUTION_ENABLED: "false" },
    { TWO_LANE_RELEASE_COMPOSITION_MODE: "production_canary" },
    { TWO_LANE_LOCAL_RELEASE_FIXTURE_OUTCOME: "unsafe" },
  ]) {
    assert.throws(
      () => factory(invalid).create(configuration),
      /LOCAL_RELEASE_FIXTURE_CONFIGURATION_INVALID/,
    );
  }
  assert.throws(
    () => factory().create({
      ...configuration,
      projectAllowlist: [
        projectId,
        "55555555-5555-4555-8555-555555555555",
      ],
    }),
    /LOCAL_RELEASE_FIXTURE_CONFIGURATION_INVALID/,
  );
  assert.throws(
    () => factory().create({
      ...configuration,
      environmentAllowlist: ["staging"],
    }),
    /LOCAL_RELEASE_FIXTURE_CONFIGURATION_INVALID/,
  );

  const adapters = factory().create(configuration);
  assert.equal(
    adapters.policy,
    "deployguard.release-lane/fixture-adapters-v1",
  );
  assert.equal(
    adapters.mutationClient.policy,
    "deployguard.ecs-release-mutation/client-v1",
  );
  assert.equal(
    adapters.rolloutVerifier.policy,
    "deployguard.ecs-rollout-health/disabled-read-only-v1",
  );
  assert.equal(
    adapters.readOnlyEvidenceClient.policy,
    "deployguard.ecs-release-reconciliation/fixture-read-only-v1",
  );
  assert.ok(adapters.firstReleaseClient);

  const request = {
    region: "us-east-1",
    repositoryUrl:
      "000000000000.dkr.ecr.us-east-1.amazonaws.com/local-fixture",
    commitSha: "c".repeat(40),
    buildFingerprint: "d".repeat(64),
    projectId,
    repositoryFullName: "fixture/local",
    branch: "main",
    appRoot: ".",
    dockerStrategy: "generated" as const,
    deploymentContractHash: "e".repeat(64),
  };
  const first = await adapters.firstReleaseClient!
    .buildAndPushImmutableImage(request, ownership());
  const second = await adapters.firstReleaseClient!
    .resolveImmutableImageEvidence(request, ownership());
  assert.deepEqual(first, second);
  assert.match(first.imageDigest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(first.imageUri.endsWith(`@${first.imageDigest}`), true);

  const task = await adapters.mutationClient
    .registerTaskDefinitionRevision({
      region: "us-east-1",
      sourceTaskDefinitionArn:
        "arn:aws:ecs:us-east-1:000000000000:task-definition/local:1",
      family: "local",
      containerName: "app",
      immutableImage: first.imageUri,
      command: null,
      containerPort: 3000,
      cpu: 256,
      memory: 512,
      logGroupName: "/deployguard/local",
      environmentReferences: [],
      serviceBindingReferences: [],
      evidenceTags: {
        projectId,
        environmentName: "dev",
        releaseManifestId: "66666666-6666-4666-8666-666666666666",
        releaseRevision: "2",
        infrastructureManifestId:
          "77777777-7777-4777-8777-777777777777",
        infrastructureRevision: "1",
        taskDefinitionInputHash: "f".repeat(64),
        imageDigest: first.imageDigest,
      },
    }, ownership());
  assert.equal(
    task.taskDefinitionArn,
    "arn:aws:ecs:us-east-1:000000000000:task-definition/local:1",
  );

  const health = await adapters.rolloutVerifier.verify({
    revision: {
      projectId,
      environmentName: "dev",
      releaseManifestId: "66666666-6666-4666-8666-666666666666",
      releaseRevision: "2",
      infrastructureManifestId:
        "77777777-7777-4777-8777-777777777777",
      infrastructureRevision: "1",
    },
    manifests: { loadExact: async () => null },
    execution: {
      signal: new AbortController().signal,
      isLeaseTrusted: () => true,
    },
    deadlineAt: new Date(Date.now() + 60_000),
  });
  assert.equal(health.status, "healthy");
  assert.match(health.evidenceHash, /^[0-9a-f]{64}$/);
  assert.deepEqual(
    await adapters.readOnlyEvidenceClient.findTaskDefinitionEvidence(
      {} as never,
      new AbortController().signal,
    ),
    [],
  );

  const ambiguousFactory = factory({
    TWO_LANE_LOCAL_RELEASE_FIXTURE_OUTCOME: "ambiguous_once",
  });
  assert.equal(ambiguousFactory.inspectConvergence({
    projectId,
    candidateDigest: first.imageDigest,
    candidateTaskDefinitionArn: task.taskDefinitionArn,
    serviceArn:
      "arn:aws:ecs:us-east-1:000000000000:service/local/local-service",
    ecrRepositoryName: "local-fixture",
  }), null);
  const ambiguousAdapters = ambiguousFactory.create(configuration);
  const ambiguousImage = await ambiguousAdapters.firstReleaseClient!
    .buildAndPushImmutableImage(request, ownership());
  const ambiguousTask = await ambiguousAdapters.mutationClient
    .registerTaskDefinitionRevision({
      region: "us-east-1",
      sourceTaskDefinitionArn:
        "arn:aws:ecs:us-east-1:000000000000:task-definition/local:1",
      family: "local",
      containerName: "app",
      immutableImage: ambiguousImage.imageUri,
      command: null,
      containerPort: 3000,
      cpu: 256,
      memory: 512,
      logGroupName: "/deployguard/local",
      environmentReferences: [],
      serviceBindingReferences: [],
      evidenceTags: {
        projectId,
        environmentName: "dev",
        releaseManifestId: "66666666-6666-4666-8666-666666666666",
        releaseRevision: "2",
        infrastructureManifestId:
          "77777777-7777-4777-8777-777777777777",
        infrastructureRevision: "1",
        taskDefinitionInputHash: "f".repeat(64),
        imageDigest: ambiguousImage.imageDigest,
      },
    }, ownership());
  const serviceArn =
    "arn:aws:ecs:us-east-1:000000000000:service/local/local-service";
  await ambiguousAdapters.mutationClient.updateExistingService({
    region: "us-east-1",
    clusterArn: "arn:aws:ecs:us-east-1:000000000000:cluster/local",
    serviceArn,
    taskDefinitionArn: ambiguousTask.taskDefinitionArn,
    forceNewDeployment: true,
  }, ownership());
  const ambiguousInput = {
    revision: {
      projectId,
      environmentName: "dev",
      releaseManifestId: "66666666-6666-4666-8666-666666666666",
      releaseRevision: "2",
      infrastructureManifestId:
        "77777777-7777-4777-8777-777777777777",
      infrastructureRevision: "1",
    },
    manifests: { loadExact: async () => null },
    execution: {
      signal: new AbortController().signal,
      isLeaseTrusted: () => true,
    },
    deadlineAt: new Date(Date.now() + 60_000),
  };
  assert.equal(
    (await ambiguousAdapters.rolloutVerifier.verify(ambiguousInput)).status,
    "ambiguous",
  );
  assert.equal(ambiguousFactory.inspectConvergence({
    projectId,
    candidateDigest: ambiguousImage.imageDigest,
    candidateTaskDefinitionArn: ambiguousTask.taskDefinitionArn,
    serviceArn,
    ecrRepositoryName: "local-fixture",
  }), true);
  assert.equal(ambiguousFactory.inspectConvergence({
    projectId,
    candidateDigest: "sha256:" + "0".repeat(64),
    candidateTaskDefinitionArn: ambiguousTask.taskDefinitionArn,
    serviceArn,
    ecrRepositoryName: "local-fixture",
  }), false);
  assert.equal(
    (await ambiguousAdapters.rolloutVerifier.verify(ambiguousInput)).status,
    "healthy",
  );

  process.stdout.write(
    "Local normal-v1 release fixture adapter verification passed.\n",
  );
}

run().catch((error) => {
  process.stderr.write(
    `Local normal-v1 release fixture adapter verification failed: ${
      error instanceof Error ? error.message : "unknown"
    }\n`,
  );
  process.exitCode = 1;
});
