import { strict as assert } from "node:assert";
import { PipelineRunStatus } from "../src/projects/project-pipeline-run.entity";
import { PipelineService } from "../src/projects/pipeline/pipeline.service";
import { PipelineWorkerService } from "../src/projects/pipeline/pipeline-worker.service";

const project = {
  id: "project-1",
  repositoryUrl: "https://github.com/example/service",
  repositoryFullName: "example/service",
  targetBranch: "main",
};
const user = { id: 7 };

function serviceWith(overrides: Record<string, unknown> = {}) {
  const removed: string[] = [];
  const queue = {
    add: async () => undefined,
    getJobs: async () => [
      {
        data: { pipelineRunId: "run-1" },
        remove: async () => removed.push("run-1"),
      },
    ],
    ...(overrides.queue as object),
  };
  const runRepository = {
    findOne: async () => null,
    create: (value: unknown) => value,
    save: async (value: unknown) => value,
    ...(overrides.runRepository as object),
  };
  const eventRepository = {
    create: (value: unknown) => value,
    save: async (value: unknown) => value,
  };
  const projectsService = {
    getProjectEntityForManage: async () => project,
  };
  const auditLogService = { record: async () => undefined };
  const service = new PipelineService(
    runRepository as never,
    eventRepository as never,
    {} as never,
    {} as never,
    queue as never,
    projectsService as never,
    auditLogService as never
  );
  return { service, removed };
}

async function verifyIdempotentStart() {
  let queueCalls = 0;
  const activeRun = {
    id: "run-1",
    projectId: project.id,
    status: PipelineRunStatus.RUNNING,
    currentStage: "docker_build",
  };
  const { service } = serviceWith({
    runRepository: { findOne: async () => activeRun },
    queue: { add: async () => { queueCalls += 1; } },
  });

  const response = await service.startRun(user as never, project.id, {});
  assert.equal(response.id, activeRun.id);
  assert.equal(response.status, PipelineRunStatus.RUNNING);
  assert.equal(queueCalls, 0, "an active run must not enqueue a duplicate job");
}

async function verifyQueuedCancellation() {
  const queuedRun = {
    id: "run-1",
    projectId: project.id,
    status: PipelineRunStatus.QUEUED,
    currentStage: "queued",
    metadata: { jobType: "full_deploy" },
  };
  const { service, removed } = serviceWith({
    runRepository: { findOne: async () => queuedRun },
  });

  const response = await service.cancelRun(user as never, project.id, queuedRun.id);
  assert.equal(response.status, PipelineRunStatus.CANCELLED);
  assert.equal(response.currentStage, "cancelled");
  assert.equal(removed.length, 1, "the waiting BullMQ job should be removed");
  assert.equal(
    (queuedRun.metadata as Record<string, unknown>).cancelRequested,
    true
  );
}

async function verifyWorkerCancellationCheckpoint() {
  const worker = Object.create(PipelineWorkerService.prototype) as {
    runRepository: { findOne: () => Promise<unknown> };
    ensureNotCancelled: (run: { id: string }) => Promise<void>;
  };
  worker.runRepository = {
    findOne: async () => ({
      status: PipelineRunStatus.RUNNING,
      metadata: { cancelRequested: true },
    }),
  };
  await assert.rejects(
    () => worker.ensureNotCancelled({ id: "run-1" }),
    /cancelled by the user/
  );
}

async function main() {
  await verifyIdempotentStart();
  await verifyQueuedCancellation();
  await verifyWorkerCancellationCheckpoint();
  console.log("Automation control checks passed.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
