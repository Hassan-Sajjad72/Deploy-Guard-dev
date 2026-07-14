import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from "typeorm";

export enum StorageRestoreStatus {
  PENDING = "pending",
  APPROVED = "approved",
  REJECTED = "rejected",
  RESTORING = "restoring",
  RESTORED = "restored",
  FAILED = "failed",
}

@Entity("project_storage_restore_requests")
export class ProjectStorageRestoreRequest {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Index()
  @Column({ name: "project_id" })
  projectId: string;

  @Column({ name: "persistent_storage_id" })
  persistentStorageId: string;

  @Column({ nullable: true, name: "recovery_point_arn" })
  recoveryPointArn: string;

  @Column({ default: StorageRestoreStatus.PENDING })
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
