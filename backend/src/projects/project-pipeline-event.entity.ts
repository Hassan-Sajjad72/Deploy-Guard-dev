import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from "typeorm";
import { Project } from "./project.entity";
import { ProjectPipelineRun } from "./project-pipeline-run.entity";

@Entity("project_pipeline_events")
export class ProjectPipelineEvent {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Index()
  @Column({ name: "pipeline_run_id" })
  pipelineRunId: string;

  @ManyToOne(() => ProjectPipelineRun, (run) => run.events, {
    nullable: false,
    onDelete: "CASCADE",
  })
  @JoinColumn({ name: "pipeline_run_id" })
  pipelineRun: ProjectPipelineRun;

  @Index()
  @Column({ name: "project_id" })
  projectId: string;

  @ManyToOne(() => Project, { nullable: false, onDelete: "CASCADE" })
  @JoinColumn({ name: "project_id" })
  project: Project;

  @Column()
  stage: string;

  @Column()
  status: string;

  @Column({ type: "text" })
  message: string;

  @Column({ nullable: true, type: "jsonb" })
  metadata: Record<string, unknown> | null;

  @Column({ name: "occurred_at", type: "timestamptz", default: () => "CURRENT_TIMESTAMP" })
  occurredAt: Date;

  @Column({ name: "ingested_at", type: "timestamptz", default: () => "CURRENT_TIMESTAMP" })
  ingestedAt: Date;

  @Column({ nullable: true, name: "duration_ms", type: "bigint" })
  durationMs: number | null;

  @Column({ default: "pipeline_worker" })
  source: string;

  @Column({ name: "sequence_number", type: "integer", default: 0 })
  sequenceNumber: number;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt: Date;
}
