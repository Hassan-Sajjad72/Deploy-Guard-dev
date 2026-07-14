import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from "typeorm";

export enum RollbackStatus {
  STARTED = "started",
  SUCCEEDED = "succeeded",
  FAILED = "failed",
}

@Entity("project_rollback_records")
export class ProjectRollbackRecord {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Index()
  @Column({ name: "project_id" })
  projectId: string;

  @Column({ name: "deployment_id" })
  deploymentId: string;

  @Column({ nullable: true, name: "pipeline_run_id" })
  pipelineRunId: string;

  @Column({ nullable: true, name: "from_commit_sha" })
  fromCommitSha: string;

  @Column({ name: "to_commit_sha" })
  toCommitSha: string;

  @Column({ nullable: true, name: "from_task_definition_arn" })
  fromTaskDefinitionArn: string;

  @Column({ nullable: true, name: "to_task_definition_arn" })
  toTaskDefinitionArn: string;

  @Column({ type: "text" })
  reason: string;

  @Column({ default: RollbackStatus.STARTED })
  status: string;

  @Column({ name: "started_at", type: "timestamp" })
  startedAt: Date;

  @Column({ nullable: true, name: "completed_at", type: "timestamp" })
  completedAt: Date;

  @Column({ nullable: true, type: "jsonb" })
  metadata: Record<string, unknown> | null;

  @Column({ nullable: true, name: "error_message", type: "text" })
  errorMessage: string;

  @CreateDateColumn({ name: "created_at" })
  createdAt: Date;
}
