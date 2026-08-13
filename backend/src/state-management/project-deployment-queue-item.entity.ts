import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from "typeorm";

export enum DeploymentQueueStatus {
  QUEUED = "queued",
  WAITING_FOR_LOCK = "waiting_for_lock",
  PROCESSING = "processing",
  COMPLETED = "completed",
  FAILED = "failed",
  CANCELLED = "cancelled",
}

@Entity("project_deployment_queue_items")
export class ProjectDeploymentQueueItem {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Index()
  @Column({ name: "project_id", type: "uuid" })
  projectId: string;

  @Column({ name: "pipeline_run_id", type: "uuid" })
  pipelineRunId: string;

  @Column({ default: "dev", name: "environment_name" })
  environmentName: string;

  @Column({ default: DeploymentQueueStatus.QUEUED })
  status: string;

  @Column({ nullable: true })
  position: number;

  @Column({ nullable: true, type: "text" })
  reason: string;

  @Column({ nullable: true, name: "started_at", type: "timestamptz" })
  startedAt: Date;

  @Column({ nullable: true, name: "completed_at", type: "timestamptz" })
  completedAt: Date;

  @Column({ nullable: true, name: "failed_at", type: "timestamptz" })
  failedAt: Date;

  @Column({ nullable: true, type: "jsonb" })
  metadata: Record<string, unknown> | null;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt: Date;

  @UpdateDateColumn({ name: "updated_at", type: "timestamptz" })
  updatedAt: Date;
}
