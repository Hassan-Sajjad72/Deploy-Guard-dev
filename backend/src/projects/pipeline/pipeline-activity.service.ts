import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { ProjectPipelineRun } from "../project-pipeline-run.entity";
import { isPipelineActive } from "./pipeline-status";

export type PipelineQueueJobSnapshot = { pipelineRunId: string; projectId: string; state: string };
export type PipelineActivitySnapshot = {
  isActive: boolean; activityType: "deployment" | null; isDeploymentJobActive: boolean;
  activePipelineRunId: string | null; pipelineRunId: string | null; stage: string | null;
  startedAt: string | null; lastHeartbeatAt: string | null; latestRunStatus: string;
  latestRunIsStale: boolean; source: "github_actions" | "none";
  authority: "database_operation" | "none"; stale: boolean; displayMessage: string;
  triggeredByUserId: number | null; queueCheckAvailable: boolean;
};

export function resolvePipelineActivity(input: {
  projectId: string;
  latestRun: Pick<ProjectPipelineRun, "id" | "projectId" | "status" | "createdAt" | "updatedAt" | "startedAt" | "currentStage" | "currentStageStartedAt" | "triggeredByUserId"> | null;
  queueJobs?: PipelineQueueJobSnapshot[]; queueCheckAvailable?: boolean; staleAfterMs: number; nowMs?: number;
}): PipelineActivitySnapshot {
  const run = input.latestRun;
  const activeRecord = Boolean(run && isPipelineActive(run.status));
  const referenceTime = run?.updatedAt || run?.startedAt || run?.createdAt;
  const ageMs = referenceTime ? (input.nowMs ?? Date.now()) - new Date(referenceTime).getTime() : Number.POSITIVE_INFINITY;
  const stale = activeRecord && ageMs > input.staleAfterMs;
  const active = activeRecord && !stale;
  return {
    isActive: active, activityType: active ? "deployment" : null, isDeploymentJobActive: active,
    activePipelineRunId: active ? run!.id : null, pipelineRunId: active ? run!.id : null,
    stage: active ? run?.currentStage || "queued" : null,
    startedAt: active ? new Date(run?.currentStageStartedAt || run?.startedAt || run?.createdAt || new Date()).toISOString() : null,
    lastHeartbeatAt: active && run?.updatedAt ? new Date(run.updatedAt).toISOString() : null,
    latestRunStatus: run?.status || "not_started", latestRunIsStale: stale,
    source: active ? "github_actions" : "none", authority: active ? "database_operation" : "none", stale,
    displayMessage: active ? `GitHub Actions deployment ${run?.currentStage || "queued"} is active.` : stale ? "The historical operation is stale; polling will reconcile it with GitHub Actions." : "No deployment operation is active.",
    triggeredByUserId: active ? run?.triggeredByUserId || null : null, queueCheckAvailable: false,
  };
}

@Injectable()
export class PipelineActivityService {
  constructor(private readonly config: ConfigService) {}
  inspect(projectId: string, latestRun: ProjectPipelineRun | null) {
    return Promise.resolve(resolvePipelineActivity({ projectId, latestRun, staleAfterMs: this.staleAfterMs }));
  }
  private get staleAfterMs() {
    const seconds = Number(this.config.get<string>("PIPELINE_RUN_STALE_SECONDS", "900"));
    return (Number.isFinite(seconds) && seconds >= 60 ? seconds : 900) * 1000;
  }
}
