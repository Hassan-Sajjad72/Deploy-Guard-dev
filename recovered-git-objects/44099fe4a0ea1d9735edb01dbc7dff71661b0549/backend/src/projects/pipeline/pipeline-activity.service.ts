import { Inject, Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Queue } from "bullmq";
import { ProjectPipelineRun } from "../project-pipeline-run.entity";
import { isPipelineActive } from "./pipeline-status";
import { PIPELINE_QUEUE, PipelineJobData } from "./pipeline.types";

export type PipelineQueueJobSnapshot = {
  pipelineRunId: string;
  projectId: string;
  state: string;
};

export type PipelineActivitySnapshot = {
  isActive: boolean;
  activityType: "deployment" | null;
  isDeploymentJobActive: boolean;
  activePipelineRunId: string | null;
  pipelineRunId: string | null;
  stage: string | null;
  startedAt: string | null;
  lastHeartbeatAt: string | null;
  latestRunStatus: string;
  latestRunIsStale: boolean;
  source: "pipeline_worker" | "none";
  authority: "bullmq" | "fresh_pipeline_record" | "none";
  stale: boolean;
  displayMessage: string;
  triggeredByUserId: number | null;
  queueCheckAvailable: boolean;
};

export function resolvePipelineActivity(input: {
  projectId: string;
  latestRun: Pick<ProjectPipelineRun, "id" | "projectId" | "status" | "createdAt" | "updatedAt" | "startedAt" | "currentStage" | "currentStageStartedAt" | "triggeredByUserId"> | null;
  queueJobs: PipelineQueueJobSnapshot[];
  queueCheckAvailable: boolean;
  staleAfterMs: number;
  nowMs?: number;
}): PipelineActivitySnapshot {
  const latestRunStatus = input.latestRun?.status || "not_started";
  const queueJob = input.queueJobs.find((job) => job.projectId === input.projectId) || null;
  const dbRunIsActive = Boolean(input.latestRun && isPipelineActive(input.latestRun.status));
  const referenceTime = input.latestRun?.updatedAt || input.latestRun?.startedAt || input.latestRun?.createdAt;
  const ageMs = referenceTime ? (input.nowMs ?? Date.now()) - new Date(referenceTime).getTime() : Number.POSITIVE_INFINITY;
  const latestRunIsStale = Boolean(
    dbRunIsActive &&
    !queueJob &&
    (input.queueCheckAvailable || ageMs > input.staleAfterMs)
  );
  const freshDatabaseRun = Boolean(
    dbRunIsActive &&
    !queueJob &&
    !input.queueCheckAvailable &&
    !latestRunIsStale
  );

  const active = Boolean(queueJob || freshDatabaseRun);
  const activePipelineRunId = queueJob?.pipelineRunId || (freshDatabaseRun ? input.latestRun!.id : null);
  return {
    isActive: active,
    activityType: active ? "deployment" : null,
    isDeploymentJobActive: active,
    activePipelineRunId,
    pipelineRunId: activePipelineRunId,
    stage: active ? input.latestRun?.currentStage || "queued" : null,
    startedAt: active ? new Date(input.latestRun?.currentStageStartedAt || input.latestRun?.startedAt || input.latestRun?.createdAt || new Date()).toISOString() : null,
    lastHeartbeatAt: active && input.latestRun?.updatedAt ? new Date(input.latestRun.updatedAt).toISOString() : null,
    latestRunStatus,
    latestRunIsStale,
    source: active ? "pipeline_worker" : "none",
    authority: queueJob ? "bullmq" : freshDatabaseRun ? "fresh_pipeline_record" : "none",
    stale: latestRunIsStale,
    displayMessage: active ? `Deployment ${input.latestRun?.currentStage || "queued"} is active.` : latestRunIsStale ? "The historical pipeline record is stale; no active deployment job exists." : "No deployment operation is active.",
    triggeredByUserId: active ? input.latestRun?.triggeredByUserId || null : null,
    queueCheckAvailable: input.queueCheckAvailable,
  };
}

@Injectable()
export class PipelineActivityService {
  private readonly logger = new Logger(PipelineActivityService.name);

  constructor(
    @Inject(PIPELINE_QUEUE) private readonly pipelineQueue: Queue<PipelineJobData>,
    private readonly config: ConfigService,
  ) {}

  async inspect(projectId: string, latestRun: ProjectPipelineRun | null): Promise<PipelineActivitySnapshot> {
    let queueCheckAvailable = true;
    let queueJobs: PipelineQueueJobSnapshot[] = [];
    try {
      const jobs = await this.withTimeout(
        this.pipelineQueue.getJobs(["active", "wait", "delayed", "prioritized", "waiting-children"], 0, -1, true),
        this.queueTimeoutMs,
      );
      queueJobs = await Promise.all(
        jobs
          .filter((job) => job.data?.projectId === projectId && job.data?.pipelineRunId)
          .map(async (job) => ({
            pipelineRunId: job.data.pipelineRunId,
            projectId: job.data.projectId,
            state: await job.getState(),
          })),
      );
    } catch (error) {
      queueCheckAvailable = false;
      this.logger.warn(`BullMQ activity check unavailable for project=${projectId}: ${this.safeMessage(error)}`);
    }

    return resolvePipelineActivity({
      projectId,
      latestRun,
      queueJobs,
      queueCheckAvailable,
      staleAfterMs: this.staleAfterMs,
    });
  }

  private async withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<T>((_, reject) => {
          timer = setTimeout(() => reject(new Error("queue activity check timed out")), timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private safeMessage(error: unknown) {
    return (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").slice(0, 160);
  }

  private get staleAfterMs() {
    const seconds = Number(this.config.get<string>("PIPELINE_RUN_STALE_SECONDS", "900"));
    return (Number.isFinite(seconds) && seconds >= 60 ? seconds : 900) * 1000;
  }

  private get queueTimeoutMs() {
    const milliseconds = Number(this.config.get<string>("PIPELINE_QUEUE_ACTIVITY_TIMEOUT_MS", "1200"));
    return Number.isFinite(milliseconds) && milliseconds >= 100 ? milliseconds : 1200;
  }
}
