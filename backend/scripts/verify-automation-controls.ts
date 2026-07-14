import { strict as assert } from "node:assert";
import { PipelineRunStatus } from "../src/projects/project-pipeline-run.entity";
import { PipelineService } from "../src/projects/pipeline/pipeline.service";
import { PipelineWorkerService } from "../src/projects/pipeline/pipeline-worker.service";
import { LogSanitizerService } from "../src/observability/log-sanitizer.service";

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
  const logSanitizer = {
    sanitize: (value: unknown) => String(value || ""),
    sanitizeMetadata: (value: Record<string, unknown>) => value,
  };
  const service = new PipelineService(
    runRepository as never,
    eventRepository as never,
    {} as never,
    {} as never,
    queue as never,
    projectsService as never,
    auditLogService as never,
    logSanitizer as never
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

async function verifyTransitionalRunDeduplication() {
  let queueCalls = 0;
  const backupRun = {
    id: "run-backup",
    projectId: project.id,
    status: PipelineRunStatus.BACKUP_CONFIGURING,
    currentStage: "backup_configuring",
  };
  const { service } = serviceWith({
    runRepository: { findOne: async () => backupRun },
    queue: { add: async () => { queueCalls += 1; } },
  });
  const response = await service.startRun(user as never, project.id, {});
  assert.equal(response.id, backupRun.id);
  assert.equal(queueCalls, 0, "backup configuration must remain an active deduplication state");
}

async function verifyTerminalFailureCannotBeCancelled() {
  const failedRun = {
    id: "run-failed",
    projectId: project.id,
    status: PipelineRunStatus.STORAGE_FAILED,
    currentStage: "storage_provisioning",
  };
  const { service } = serviceWith({ runRepository: { findOne: async () => failedRun } });
  await assert.rejects(
    () => service.cancelRun(user as never, project.id, failedRun.id),
    /cannot be cancelled/
  );
  await service.assertRetryableRun(user as never, project.id, failedRun.id);
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

function verifyFrontendSafeSanitization() {
  const sanitizer = new LogSanitizerService();
  const value = sanitizer.sanitize("authorization=Bearer abcdefghijklmnopqrstuvwxyz password=hunter2 ghp_abcdefghijklmnopqrstuvwxyz123456");
  assert.equal(value.includes("hunter2"), false);
  assert.equal(value.includes("ghp_abcdefghijklmnopqrstuvwxyz123456"), false);
  assert.equal(value.includes("abcdefghijklmnopqrstuvwxyz"), false);
}

async function main() {
  await verifyIdempotentStart();
  await verifyQueuedCancellation();
  await verifyTransitionalRunDeduplication();
  await verifyTerminalFailureCannotBeCancelled();
  await verifyWorkerCancellationCheckpoint();
  verifyFrontendSafeSanitization();
  console.log("Automation control checks passed.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
