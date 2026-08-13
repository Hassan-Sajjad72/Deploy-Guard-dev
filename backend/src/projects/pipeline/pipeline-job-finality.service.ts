import { createHash } from "crypto";
import { Injectable, Logger, Optional } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectRepository } from "@nestjs/typeorm";
import { DataSource, Repository } from "typeorm";
import { ProjectPipelineEvent } from "../project-pipeline-event.entity";
import { PipelineRunStatus, ProjectPipelineRun } from "../project-pipeline-run.entity";
import {
  LegacyPipelineJobFinalityDecision,
  ProjectPipelineJobFinality,
} from "./project-pipeline-job-finality.entity";
import { InactiveLegacyShadowInsertionAdapter } from "../../orchestration-contracts/release-lane/inactive-legacy-shadow-insertion.adapter";
import {
  CrossLaneOwnershipEnforcementService,
} from "../../orchestration-contracts/release-lane/cross-lane-ownership-enforcement.service";

export type PipelineJobFinalityEvidence = {
  projectId: string;
  pipelineRunId: string;
  bullmqJobId: string;
  decision: LegacyPipelineJobFinalityDecision;
};

export type PipelineJobFinalityResult =
  | { enabled: false }
  | { enabled: true; disposition: "not_eligible" }
  | { enabled: true; disposition: "recorded" | "already_recorded"; finality: PipelineJobFinalityEvidence };

type CompletedInput = { pipelineRunId: string; bullmqJobId: string };
type FailedInput = CompletedInput & {
  queueState: "failed";
  attemptsMade: number;
  configuredAttempts: number;
};

const JOB_ID = /^[A-Za-z0-9._:-]{1,160}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

@Injectable()
export class PipelineJobFinalityService {
  private readonly logger = new Logger(PipelineJobFinalityService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly config: ConfigService,
    @InjectRepository(ProjectPipelineJobFinality)
    private readonly finalities: Repository<ProjectPipelineJobFinality>,
    @Optional() private readonly legacyShadow?: InactiveLegacyShadowInsertionAdapter,
    @Optional() private readonly crossLane?: CrossLaneOwnershipEnforcementService,
  ) {}

  async recordCompleted(input: CompletedInput): Promise<PipelineJobFinalityResult> {
    if (!this.isEnabled()) return { enabled: false };
    const result = await this.record(input, "completed");
    await this.releaseTerminalOwnership(result);
    this.observeTerminalFinality(result);
    return result;
  }

  async recordFailedAfterRetriesExhausted(input: FailedInput): Promise<PipelineJobFinalityResult> {
    if (!this.isEnabled()) return { enabled: false };
    if (
      input.queueState !== "failed" ||
      !Number.isSafeInteger(input.attemptsMade) ||
      !Number.isSafeInteger(input.configuredAttempts) ||
      input.attemptsMade < 1 ||
      input.configuredAttempts < 1 ||
      input.attemptsMade < input.configuredAttempts
    ) {
      return { enabled: true, disposition: "not_eligible" };
    }
    const result = await this.record(input, "failed_after_retries_exhausted");
    await this.releaseTerminalOwnership(result);
    this.observeTerminalFinality(result);
    return result;
  }

  /** Worker event callbacks use this wrapper so evidence failures are inert. */
  async recordCompletedSafely(input: CompletedInput): Promise<void> {
    try {
      await this.recordCompleted(input);
    } catch (error) {
      this.logger.warn(`Pipeline job finality completion evidence skipped: ${safeFailureCode(error)}`);
    }
  }

  async recordFailedSafely(input: FailedInput): Promise<void> {
    try {
      await this.recordFailedAfterRetriesExhausted(input);
    } catch (error) {
      this.logger.warn(`Pipeline job finality failure evidence skipped: ${safeFailureCode(error)}`);
    }
  }

  private isEnabled(): boolean {
    return this.config.get<unknown>("LEGACY_PIPELINE_JOB_FINALITY_EVIDENCE_ENABLED") === "true";
  }

  private observeTerminalFinality(result: PipelineJobFinalityResult): void {
    if (!result.enabled || result.disposition === "not_eligible") return;
    if (result.finality.decision === "completed") {
      this.legacyShadow?.observeWorkerTerminalCompleted(result.finality);
      return;
    }
    this.legacyShadow?.observeWorkerTerminalFailed(result.finality);
  }

  private async releaseTerminalOwnership(
    result: PipelineJobFinalityResult,
  ): Promise<void> {
    if (
      !this.crossLane
      || !result.enabled
      || result.disposition === "not_eligible"
    ) {
      return;
    }
    try {
      const run = await this.dataSource.getRepository(ProjectPipelineRun).findOne({
        where: {
          id: result.finality.pipelineRunId,
          projectId: result.finality.projectId,
        },
        select: {
          id: true,
          projectId: true,
          crossLaneOwnerLane: true,
          crossLaneOwnerEnvironmentName: true,
          crossLaneOwnerLeaseId: true,
          crossLaneOwnerActorId: true,
          crossLaneOwnerFencingToken: true,
        },
      });
      if (!run) return;
      const claim = this.crossLane.legacyClaimFromRun(run);
      if (!claim.enabled) return;
      await this.crossLane.releaseLegacyRun(claim, run.id);
    } catch (error) {
      this.logger.warn(
        `Pipeline job finality ownership release skipped: ${safeFailureCode(error)}`,
      );
    }
  }

  private async record(
    input: CompletedInput,
    decision: LegacyPipelineJobFinalityDecision,
  ): Promise<PipelineJobFinalityResult> {
    if (!UUID.test(input.pipelineRunId) || !JOB_ID.test(input.bullmqJobId)) {
      return { enabled: true, disposition: "not_eligible" };
    }

    return this.dataSource.transaction("SERIALIZABLE", async (manager) => {
      const finalities = manager.getRepository(ProjectPipelineJobFinality);
      const existing = await finalities.findOne({
        where: { pipelineRunId: input.pipelineRunId, bullmqJobId: input.bullmqJobId },
      });
      if (existing) {
        if (existing.decision !== decision) {
          throw new Error("pipeline_job_finality_conflict");
        }
        return { enabled: true, disposition: "already_recorded", finality: evidence(existing) } as const;
      }

      const runs = manager.getRepository(ProjectPipelineRun);
      const events = manager.getRepository(ProjectPipelineEvent);
      const run = await runs.findOne({
        where: { id: input.pipelineRunId },
        select: { id: true, projectId: true, status: true, completedAt: true, failedAt: true },
      });
      if (!run || !this.matchesRunDecision(run.status, decision)) {
        return { enabled: true, disposition: "not_eligible" } as const;
      }
      const terminalAt = decision === "completed" ? run.completedAt : run.failedAt;
      if (!terminalAt) return { enabled: true, disposition: "not_eligible" } as const;
      const event = await events.findOne({
        where: {
          pipelineRunId: run.id,
          status: decision === "completed" ? "success" : "failed",
        },
        select: { id: true, occurredAt: true },
        order: { occurredAt: "DESC", sequenceNumber: "DESC" },
      });
      if (!event || event.occurredAt.getTime() < terminalAt.getTime()) {
        return { enabled: true, disposition: "not_eligible" } as const;
      }

      const evidenceHash = hashEvidence(run.projectId, run.id, input.bullmqJobId, decision);
      try {
        await finalities.insert(finalities.create({
          projectId: run.projectId,
          pipelineRunId: run.id,
          bullmqJobId: input.bullmqJobId,
          decision,
          evidenceHash,
        }));
        return { enabled: true, disposition: "recorded", finality: evidence({
          projectId: run.projectId,
          pipelineRunId: run.id,
          bullmqJobId: input.bullmqJobId,
          decision,
        }) } as const;
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
        const replay = await finalities.findOne({
          where: { pipelineRunId: input.pipelineRunId, bullmqJobId: input.bullmqJobId },
        });
        if (!replay || replay.decision !== decision) throw new Error("pipeline_job_finality_conflict");
        return { enabled: true, disposition: "already_recorded", finality: evidence(replay) } as const;
      }
    });
  }

  private matchesRunDecision(status: PipelineRunStatus, decision: LegacyPipelineJobFinalityDecision): boolean {
    if (decision === "completed") return status === PipelineRunStatus.COMPLETED;
    return status === PipelineRunStatus.FAILED || status === PipelineRunStatus.STORAGE_FAILED;
  }
}

function evidence(row: Pick<ProjectPipelineJobFinality, "projectId" | "pipelineRunId" | "bullmqJobId" | "decision">): PipelineJobFinalityEvidence {
  return {
    projectId: row.projectId,
    pipelineRunId: row.pipelineRunId,
    bullmqJobId: row.bullmqJobId,
    decision: row.decision,
  };
}

function hashEvidence(projectId: string, pipelineRunId: string, bullmqJobId: string, decision: LegacyPipelineJobFinalityDecision): string {
  return createHash("sha256")
    .update(JSON.stringify({ version: 1, projectId, pipelineRunId, bullmqJobId, decision }))
    .digest("hex");
}

function isUniqueViolation(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && (error as { code?: unknown }).code === "23505");
}

function safeFailureCode(error: unknown): string {
  if (error && typeof error === "object" && (error as { code?: unknown }).code === "23505") return "duplicate";
  return "persistence_unavailable";
}
