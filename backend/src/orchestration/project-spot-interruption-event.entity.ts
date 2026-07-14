import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from "typeorm";

export enum SpotInterruptionStatus {
  RECEIVED = "received",
  REPLACEMENT_TRIGGERED = "replacement_triggered",
  HANDLED = "handled",
  FAILED = "failed",
}

@Entity("project_spot_interruption_events")
export class ProjectSpotInterruptionEvent {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Index()
  @Column({ name: "project_id" })
  projectId: string;

  @Column({ nullable: true, name: "deployment_id" })
  deploymentId: string;

  @Column({ nullable: true, name: "pipeline_run_id" })
  pipelineRunId: string;

  @Column({ nullable: true, name: "ecs_cluster_arn" })
  ecsClusterArn: string;

  @Column({ nullable: true, name: "ecs_service_arn" })
  ecsServiceArn: string;

  @Column({ nullable: true, name: "task_arn" })
  taskArn: string;

  @Column({ nullable: true, name: "event_id" })
  eventId: string;

  @Column({ nullable: true, name: "event_time", type: "timestamp" })
  eventTime: Date;

  @Column({ nullable: true })
  reason: string;

  @Column({ default: SpotInterruptionStatus.RECEIVED })
  status: string;

  @Column({ nullable: true, type: "jsonb" })
  metadata: Record<string, unknown> | null;

  @CreateDateColumn({ name: "created_at" })
  createdAt: Date;

  @UpdateDateColumn({ name: "updated_at" })
  updatedAt: Date;
}
