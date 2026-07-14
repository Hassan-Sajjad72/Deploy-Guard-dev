import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from "typeorm";

export enum StateRecoveryStatus {
  PENDING = "pending",
  APPROVED = "approved",
  REJECTED = "rejected",
  COMPLETED = "completed",
  FAILED = "failed",
}

@Entity("project_state_recovery_requests")
export class ProjectStateRecoveryRequest {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Index()
  @Column({ name: "project_id" })
  projectId: string;

  @Column({ default: "dev", name: "environment_name" })
  environmentName: string;

  @Column({ nullable: true, name: "corrupted_version_id" })
  corruptedVersionId: string;

  @Column({ nullable: true, name: "recovery_version_id" })
  recoveryVersionId: string;

  @Column({ default: StateRecoveryStatus.PENDING })
  status: string;

  @Column({ nullable: true, name: "requested_by_user_id" })
  requestedByUserId: number;

  @Column({ nullable: true, name: "approved_by_user_id" })
  approvedByUserId: number;

  @Column({ nullable: true, type: "text" })
  reason: string;

  @Column({ nullable: true, name: "completed_at", type: "timestamp" })
  completedAt: Date;

  @Column({ nullable: true, type: "jsonb" })
  metadata: Record<string, unknown> | null;

  @CreateDateColumn({ name: "created_at" })
  createdAt: Date;

  @UpdateDateColumn({ name: "updated_at" })
  updatedAt: Date;
}
