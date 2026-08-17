import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from "typeorm";
import { ProjectInfrastructureEnvironment } from "../infrastructure/project-infrastructure-environment.entity";
import { ProjectPipelineRun } from "../projects/project-pipeline-run.entity";
import { Project } from "../projects/project.entity";

export enum PersistentStorageStatus {
  NOT_REQUIRED = "not_required",
  RECOMMENDED = "recommended",
  PENDING = "pending",
  PROVISIONING = "provisioning",
  PROVISIONED = "provisioned",
  FAILED = "failed",
  BACKUP_CONFIGURED = "backup_configured",
  RESTORE_PENDING = "restore_pending",
  RESTORED = "restored",
}

export enum PersistentStorageType {
  EFS = "efs",
}

@Entity("project_persistent_storage")
export class ProjectPersistentStorage {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Index()
  @Column({ name: "project_id" })
  projectId: string;

  @ManyToOne(() => Project, { nullable: false, onDelete: "CASCADE" })
  @JoinColumn({ name: "project_id" })
  project: Project;

  @Column({ nullable: true, name: "infrastructure_environment_id" })
  infrastructureEnvironmentId: string;

  @ManyToOne(() => ProjectInfrastructureEnvironment, { nullable: true, onDelete: "SET NULL" })
  @JoinColumn({ name: "infrastructure_environment_id" })
  infrastructureEnvironment: ProjectInfrastructureEnvironment;

  @Column({ nullable: true, name: "pipeline_run_id" })
  pipelineRunId: string;

  @ManyToOne(() => ProjectPipelineRun, { nullable: true, onDelete: "SET NULL" })
  @JoinColumn({ name: "pipeline_run_id" })
  pipelineRun: ProjectPipelineRun;

  @Column({ default: "dev", name: "environment_name" })
  environmentName: string;

  @Column({ default: false })
  enabled: boolean;

  @Column({ default: false, name: "required_by_detection" })
  requiredByDetection: boolean;

  @Column({ default: false, name: "user_enabled" })
  userEnabled: boolean;

  @Column({ default: PersistentStorageStatus.NOT_REQUIRED })
  status: string;

  @Column({ default: PersistentStorageType.EFS, name: "storage_type" })
  storageType: string;

  @Column({ nullable: true, name: "aws_region" })
  awsRegion: string;

  @Column({ nullable: true, name: "efs_file_system_id" })
  efsFileSystemId: string;

  @Column({ nullable: true, name: "efs_file_system_arn" })
  efsFileSystemArn: string;

  @Column({ nullable: true, name: "efs_dns_name" })
  efsDnsName: string;

  @Column({ nullable: true, name: "efs_access_point_id" })
  efsAccessPointId: string;

  @Column({ nullable: true, name: "efs_access_point_arn" })
  efsAccessPointArn: string;

  @Column({ nullable: true, name: "efs_security_group_id" })
  efsSecurityGroupId: string;

  @Column({ nullable: true, name: "kms_key_id" })
  kmsKeyId: string;

  @Column({ nullable: true, name: "kms_key_arn" })
  kmsKeyArn: string;

  @Column({ nullable: true, name: "mount_target_ids", type: "jsonb" })
  mountTargetIds: string[] | null;

  @Column({ nullable: true, name: "root_directory" })
  rootDirectory: string;

  @Column({ default: 1000, name: "posix_uid" })
  posixUid: number;

  @Column({ default: 1000, name: "posix_gid" })
  posixGid: number;

  @Column({ default: "750", name: "root_permissions" })
  rootPermissions: string;

  @Column({ default: true })
  encrypted: boolean;

  @Column({ default: true, name: "backup_enabled" })
  backupEnabled: boolean;

  @Column({ nullable: true, name: "backup_vault_name" })
  backupVaultName: string;

  @Column({ nullable: true, name: "backup_plan_id" })
  backupPlanId: string;

  @Column({ nullable: true, name: "backup_retention_days" })
  backupRetentionDays: number;

  @Column({ nullable: true, name: "ecs_mount_config", type: "jsonb" })
  ecsMountConfig: Record<string, unknown> | null;

  @Column({ nullable: true, type: "jsonb" })
  metadata: Record<string, unknown> | null;

  @Column({ nullable: true, name: "error_message", type: "text" })
  errorMessage: string;

  @Column({ nullable: true, name: "provisioned_at", type: "timestamptz" })
  provisionedAt: Date;

  @Column({ nullable: true, name: "failed_at", type: "timestamptz" })
  failedAt: Date;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt: Date;

  @UpdateDateColumn({ name: "updated_at", type: "timestamptz" })
  updatedAt: Date;
}
