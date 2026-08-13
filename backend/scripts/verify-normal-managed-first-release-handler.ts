import { strict as assert } from "node:assert";
import { LaterReleaseImagePreparationService } from "../src/orchestration-contracts/release-lane/later-release-image-preparation.service";
import { InactiveV1EcsReleaseHandler } from "../src/orchestration-contracts/worker-runtime/inactive-v1-ecs-release-handler";

const projectId = "11111111-1111-4111-8111-111111111111";
const infrastructureManifestId = "22222222-2222-4222-8222-222222222222";
const releaseManifestId = "33333333-3333-4333-8333-333333333333";
const intentId = "44444444-4444-4444-8444-444444444444";
let bootstraps = 0;

const handler = new InactiveV1EcsReleaseHandler({ mutate: async () => { throw new Error("later path must not run"); } } as any, { coordinate: async () => { throw new Error("later path must not run"); } } as any, {
  firstRelease: {
    dataSource: { getRepository: () => ({ findOne: async () => ({
      infrastructureRevision: "1",
      draftHash: "a".repeat(64),
      releaseDraft: {
        schemaVersion: 1, projectId, environmentName: "dev", infrastructureManifestId,
        parentManifestId: null, previousStableManifestId: null, deploymentContractId: null,
        configurationSnapshotId: null, origin: "planner", repositoryFullName: "example/smart-retail",
        branch: "main", commitSha: "b".repeat(40), appRoot: ".", deploymentContractHash: "c".repeat(64),
        configurationFingerprint: "d".repeat(64), buildFingerprint: "e".repeat(64), runtimeFingerprint: "f".repeat(64),
        releaseSpec: { source: { repositoryFullName: "example/smart-retail", branch: "main", commitSha: "b".repeat(40), appRoot: "." }, build: { dockerStrategy: "generated", dockerTemplate: "node-server", buildCommand: "npm run build", outputDirectory: null, buildArgumentNames: [] }, runtime: { imageUri: null, imageDigest: null, command: null, containerPort: 3000, cpu: 256, memory: 512, plainVariableNames: [], secretReferenceNames: ["JWT_SECRET"], serviceBindingRevisions: [] }, health: { path: "/", expectedPort: 3000, gracePeriodSeconds: 30 } },
        specHash: "1".repeat(64),
      },
    }) }) } as any,
    bootstrap: { bootstrap: async (input: any) => { bootstraps += 1; assert.equal(input.identity.intentId, intentId); assert.equal(input.identity.infrastructureManifestId, infrastructureManifestId); return { disposition: "initial_release_healthy" }; } } as any,
  },
});

const context: any = {
  leaseId: "55555555-5555-4555-8555-555555555555", workerId: "fixture-worker", fencingToken: "1", logicalJobId: "fixture-job",
  intent: { id: intentId, projectId, environmentName: "dev", classification: "release_only", status: "running", canonicalIdempotencyKey: "0".repeat(64), infrastructureManifestId, releaseManifestId, pipelineRunId: null, destroyOperationId: null },
  infrastructureManifest: { id: infrastructureManifestId, projectId, environmentName: "dev", revision: "1", status: "applied" },
  releaseManifest: { id: releaseManifestId, projectId, environmentName: "dev", infrastructureManifestId, parentManifestId: null, previousStableManifestId: null, status: "desired" },
  route: { messageType: "intent.release.execute", lane: "release", operation: "execute", queueName: "deployguard-release-v1" },
  execution: { signal: new AbortController().signal, isLeaseTrusted: () => true },
  sideEffects: {}, envelope: {},
};

void (async () => {
  const results = await Promise.all(
    ["desired", "built", "building"].map((status) =>
      handler.invoke({
        ...context,
        releaseManifest: { ...context.releaseManifest, status },
      })
    ),
  );
  for (const result of results) {
    assert.deepEqual(result, { outcome: "success" });
  }
  assert.equal(bootstraps, 3);
  await new LaterReleaseImagePreparationService(
    { query: async () => { throw new Error("initial release must not query"); } } as any,
    { buildAndPushImmutableImage: async () => { throw new Error("initial release must not push"); } } as any,
  ).prepare(context);
  console.log("Normal managed first-release handler fixture verification passed");
})().catch((error) => { console.error(error); process.exitCode = 1; });
