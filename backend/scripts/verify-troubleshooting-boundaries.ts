import { strict as assert } from "node:assert";
import { ParseUUIDPipe } from "@nestjs/common";
import { AiTroubleshootingService } from "../src/ai-troubleshooting/ai-troubleshooting.service";

const user = { id: 7 } as any;
const projectId = "11111111-1111-4111-8111-111111111111";
const sessionId = "22222222-2222-4222-8222-222222222222";

async function verifyMalformedUuidStopsAtBoundary() {
  const pipe = new ParseUUIDPipe();
  let databaseCalls = 0;
  await assert.rejects(
    () => pipe.transform("[object Event]", { type: "param", data: "sessionId", metatype: String }),
    (error: any) => error?.getStatus?.() === 400,
  );
  assert.equal(databaseCalls, 0, "malformed session IDs must be rejected before any database query");
  assert.equal(await pipe.transform(sessionId, { type: "param", data: "sessionId", metatype: String }), sessionId);
}

async function verifySessionOperationTimestamps() {
  const failedAt = new Date("2026-08-29T10:02:00.000Z");
  const completedAt = new Date("2026-08-29T10:03:00.000Z");
  const startedAt = new Date("2026-08-29T10:00:00.000Z");
  const createdAt = new Date("2026-08-29T09:59:00.000Z");
  const run = {
    id: "33333333-3333-4333-8333-333333333333", commitSha: "a".repeat(40), generationId: null, currentStage: "build_immutable_railpack_image",
    failedAt, completedAt, startedAt, createdAt, errorMessage: "sanitized failure", metadata: { deploymentAction: "deploy", failedStage: "build_immutable_railpack_image" },
  };
  const service = Object.create(AiTroubleshootingService.prototype) as any;
  service.sessionFor = async () => ({ id: sessionId, pipelineRunId: run.id });
  service.messages = { find: async () => [] };
  service.results = { find: async () => [] };
  service.evidenceService = { collect: async () => ({ context: {}, groups: {} }) };
  service.runs = { findOne: async () => run };
  service.provider = { availability: async () => ({ available: false }) };
  service.projects = { findOne: async () => ({ name: "Example", repositoryFullName: "example/app" }) };
  const response = await service.get(user, projectId, sessionId);
  assert.deepEqual(response.operation, {
    id: run.id, action: "deploy", commitSha: run.commitSha, generationId: null, failedStage: run.currentStage, failedStageLabel: "Build Application",
    failedAt, completedAt, startedAt, createdAt, summary: "sanitized failure",
    failureOwner: "UNVERIFIED", externalProvider: undefined, failureCode: undefined, failureServiceId: undefined,
  });
}

void (async () => {
  await verifyMalformedUuidStopsAtBoundary();
  await verifySessionOperationTimestamps();
  console.log("TROUBLESHOOTING_BOUNDARIES=PASS");
})().catch((error) => { console.error(error); process.exitCode = 1; });
