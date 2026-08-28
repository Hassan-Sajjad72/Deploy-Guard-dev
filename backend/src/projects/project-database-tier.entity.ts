import { Column, CreateDateColumn, Entity, Index, JoinColumn, OneToOne, PrimaryGeneratedColumn, UpdateDateColumn } from "typeorm";
import { Project } from "./project.entity";
import { ManagedDatabaseEngine } from "./managed-database-engine";

export enum DatabaseTierProvider {
  MANAGED = "managed",
  EXTERNAL = "external",
  NONE = "none",
}

export enum DatabaseTierStatus {
  NOT_REQUIRED = "not_required",
  SETUP_REQUIRED = "setup_required",
  PENDING = "pending",
  PROVISIONING = "provisioning",
  READY = "ready",
  UNHEALTHY = "unhealthy",
}

@Entity("project_database_tiers")
export class ProjectDatabaseTier {
  @PrimaryGeneratedColumn("uuid") id: string;
  @Index({ unique: true }) @Column({ name: "project_id" }) projectId: string;
  @OneToOne(() => Project, { onDelete: "CASCADE" }) @JoinColumn({ name: "project_id" }) project: Project;
  @Index() @Column({ nullable: true, name: "active_generation_id", type: "uuid" }) activeGenerationId: string | null;
  @Column({ nullable: true }) engine: ManagedDatabaseEngine | null;
  @Column({ type: "enum", enum: DatabaseTierProvider, nullable: true }) provider: DatabaseTierProvider | null;
  @Column({ type: "enum", enum: DatabaseTierStatus, default: DatabaseTierStatus.SETUP_REQUIRED }) status: DatabaseTierStatus;
  @Column({ nullable: true, name: "external_host" }) externalHost: string | null;
  @Column({ nullable: true, type: "integer", name: "external_port" }) externalPort: number | null;
  @Column({ default: true, name: "external_tls_required" }) externalTlsRequired: boolean;
  @Column({ nullable: true, name: "internal_host" }) internalHost: string | null;
  @Column({ nullable: true, name: "database_name" }) databaseName: string | null;
  @Column({ nullable: true, name: "database_user" }) databaseUser: string | null;
  @Column({ default: true, name: "persistence_enabled" }) persistenceEnabled: boolean;
  @Column({ default: false, name: "backup_enabled" }) backupEnabled: boolean;
  @Column({ nullable: true, name: "efs_file_system_id" }) efsFileSystemId: string | null;
  @Column({ nullable: true, name: "efs_access_point_id" }) efsAccessPointId: string | null;
  @Column({ nullable: true, name: "credentials_secret_arn" }) credentialsSecretArn: string | null;
  @Column({ nullable: true, name: "database_url_secret_arn" }) databaseUrlSecretArn: string | null;
  @Column({ nullable: true, name: "backup_plan_id" }) backupPlanId: string | null;
  @Column({ nullable: true, type: "timestamptz", name: "last_backup_at" }) lastBackupAt: Date | null;
  @Column({ nullable: true, type: "timestamptz", name: "last_restore_at" }) lastRestoreAt: Date | null;
  @Column({ nullable: true, type: "jsonb", name: "restore_metadata" }) restoreMetadata: Record<string, unknown> | null;
  @Column({ nullable: true, name: "last_error" }) lastError: string | null;
  @CreateDateColumn({ name: "created_at", type: "timestamptz" }) createdAt: Date;
  @UpdateDateColumn({ name: "updated_at", type: "timestamptz" }) updatedAt: Date;
}
