import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn, UpdateDateColumn } from "typeorm";
import { ProjectPersistentStorage } from "./project-persistent-storage.entity";

export enum BackupRecordStatus {
  CONFIGURED = "configured",
  BACKUP_AVAILABLE = "backup_available",
  RESTORE_REQUESTED = "restore_requested",
  RESTORE_IN_PROGRESS = "restore_in_progress",
  RESTORED = "restored",
  FAILED = "failed",
}

@Entity("project_backup_records")
export class ProjectBackupRecord {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Index()
  @Column({ name: "project_id" })
  projectId: string;

  @Column({ name: "persistent_storage_id" })
  persistentStorageId: string;

  @ManyToOne(() => ProjectPersistentStorage, { nullable: false, onDelete: "CASCADE" })
  @JoinColumn({ name: "persistent_storage_id" })
  persistentStorage: ProjectPersistentStorage;

  @Column({ default: "aws_backup", name: "backup_provider" })
  backupProvider: string;

  @Column({ nullable: true, name: "backup_vault_name" })
  backupVaultName: string;

  @Column({ nullable: true, name: "backup_plan_id" })
  backupPlanId: string;

  @Column({ nullable: true, name: "recovery_point_arn" })
  recoveryPointArn: string;

  @Column({ default: BackupRecordStatus.CONFIGURED })
  status: string;

  @Column({ nullable: true, name: "retention_days" })
  retentionDays: number;

  @Column({ nullable: true })
  schedule: string;

  @Column({ nullable: true, type: "jsonb" })
  metadata: Record<string, unknown> | null;

  @CreateDateColumn({ name: "created_at" })
  createdAt: Date;

  @UpdateDateColumn({ name: "updated_at" })
  updatedAt: Date;
}
