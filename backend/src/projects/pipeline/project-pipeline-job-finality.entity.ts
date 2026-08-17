import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
} from "typeorm";
import { Project } from "../project.entity";
import { ProjectPipelineRun } from "../project-pipeline-run.entity";

export type LegacyPipelineJobFinalityDecision =
  | "completed"
  | "failed_after_retries_exhausted";

/**
 * Default-off evidence for an exact legacy BullMQ job. This is not a cloud
 * outcome, a worker-terminal observation, or a retry/reconciliation record.
 */
@Entity("project_pipeline_job_finalities")
@Unique("UQ_pipeline_job_finality_run_job", ["pipelineRunId", "bullmqJobId"])
@Index("IDX_pipeline_job_finality_project_recorded", ["projectId", "recordedAt"])
@Check(
  "CHK_pipeline_job_finality_decision",
  `"decision" IN ('completed','failed_after_retries_exhausted')`,
)
@Check(
  "CHK_pipeline_job_finality_evidence_hash",
  `"evidence_hash" ~ '^[0-9a-f]{64}$'`,
)
export class ProjectPipelineJobFinality {
  @PrimaryGeneratedColumn("uuid") id: string;

  @Index("IDX_pipeline_job_finality_run")
  @Column({ name: "pipeline_run_id", type: "uuid" }) pipelineRunId: string;

  @ManyToOne(() => ProjectPipelineRun, { nullable: false, onDelete: "RESTRICT" })
  @JoinColumn({ name: "pipeline_run_id" }) pipelineRun: ProjectPipelineRun;

  @Column({ name: "project_id", type: "uuid" }) projectId: string;

  @ManyToOne(() => Project, { nullable: false, onDelete: "RESTRICT" })
  @JoinColumn({ name: "project_id" }) project: Project;

  /** Exact queue identifier; no payload, error text, or runtime output. */
  @Column({ name: "bullmq_job_id", length: 160 }) bullmqJobId: string;

  @Column({ length: 40 }) decision: LegacyPipelineJobFinalityDecision;

  @Column({ name: "evidence_hash", type: "char", length: 64 }) evidenceHash: string;

  @CreateDateColumn({ name: "recorded_at", type: "timestamptz" }) recordedAt: Date;
}
