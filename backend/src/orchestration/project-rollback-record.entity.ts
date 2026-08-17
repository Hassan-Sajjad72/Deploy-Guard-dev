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
  @Column({ name: "project_id", type: "uuid" })
  projectId: string;

  @Column({ name: "deployment_id", type: "uuid" })
  deploymentId: string;

  @Column({ nullable: true, name: "pipeline_run_id", type: "uuid" })
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

  @Column({ name: "started_at", type: "timestamptz" })
  startedAt: Date;

  @Column({ nullable: true, name: "completed_at", type: "timestamptz" })
  completedAt: Date;

  @Column({ nullable: true, type: "jsonb" })
  metadata: Record<string, unknown> | null;

  @Column({ nullable: true, name: "error_message", type: "text" })
  errorMessage: string;

  /** Nullable, inactive cross-lane fence correlation for future legacy work. */
  @Index("IDX_rollback_records_cross_lane_ownership")
  @Column({ nullable: true, name: "cross_lane_ownership_id", type: "uuid" })
  crossLaneOwnershipId: string | null;

  @Column({ nullable: true, name: "cross_lane_owner_lane", length: 16 })
  crossLaneOwnerLane: "legacy" | "v1" | null;

  @Column({ nullable: true, name: "cross_lane_owner_environment_name", length: 64 })
  crossLaneOwnerEnvironmentName: string | null;

  @Column({ nullable: true, name: "cross_lane_owner_lease_id", type: "uuid" })
  crossLaneOwnerLeaseId: string | null;

  @Column({ nullable: true, name: "cross_lane_owner_actor_id", length: 160 })
  crossLaneOwnerActorId: string | null;

  @Column({ nullable: true, name: "cross_lane_owner_fencing_token", type: "bigint" })
  crossLaneOwnerFencingToken: string | null;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt: Date;
}
