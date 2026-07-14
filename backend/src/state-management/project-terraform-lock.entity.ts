import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from "typeorm";

export enum TerraformLockStatus {
  ACQUIRED = "acquired",
  HEARTBEAT_ACTIVE = "heartbeat_active",
  QUEUED = "queued",
  RELEASED = "released",
  ORPHANED = "orphaned",
  FORCE_RELEASED = "force_released",
  FAILED = "failed",
}

@Entity("project_terraform_locks")
@Unique(["lockId"])
export class ProjectTerraformLock {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ name: "lock_id" })
  lockId: string;

  @Index()
  @Column({ name: "project_id" })
  projectId: string;

  @Column({ name: "pipeline_run_id" })
  pipelineRunId: string;

  @Column({ nullable: true, name: "deployment_id" })
  deploymentId: string;

  @Column({ default: "dev", name: "environment_name" })
  environmentName: string;

  @Column({ nullable: true, name: "user_id" })
  userId: number;

  @Column({ default: TerraformLockStatus.ACQUIRED })
  status: string;

  @Column({ nullable: true, name: "owner_worker_id" })
  ownerWorkerId: string;

  @Column({ nullable: true, name: "terraform_pid" })
  terraformPid: number;

  @Column({ name: "acquired_at", type: "timestamp" })
  acquiredAt: Date;

  @Column({ nullable: true, name: "heartbeat_at", type: "timestamp" })
  heartbeatAt: Date;

  @Column({ default: 30, name: "heartbeat_interval_seconds" })
  heartbeatIntervalSeconds: number;

  @Column({ default: 300, name: "stale_after_seconds" })
  staleAfterSeconds: number;

  @Column({ nullable: true, name: "released_at", type: "timestamp" })
  releasedAt: Date;

  @Column({ nullable: true, name: "force_released_at", type: "timestamp" })
  forceReleasedAt: Date;

  @Column({ nullable: true, type: "jsonb" })
  metadata: Record<string, unknown> | null;

  @CreateDateColumn({ name: "created_at" })
  createdAt: Date;

  @UpdateDateColumn({ name: "updated_at" })
  updatedAt: Date;
}
