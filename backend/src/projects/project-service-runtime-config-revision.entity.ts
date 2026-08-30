import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn, Unique } from "typeorm";
import { Project } from "./project.entity";
import { ProjectDeployableService } from "./project-deployable-service.entity";

/**
 * Immutable, secret-free snapshot of the exact runtime configuration supplied
 * to one service revision. Secret values never enter this table; ECS
 * valueFrom references are pinned to an immutable Secrets Manager version id.
 */
@Entity("project_service_runtime_config_revisions")
@Unique("UQ_service_runtime_config_operation", ["createdByOperationId", "serviceId"])
export class ProjectServiceRuntimeConfigRevision {
  @PrimaryGeneratedColumn("uuid") id: string;
  @Index() @Column({ name: "project_id", type: "uuid" }) projectId: string;
  @ManyToOne(() => Project, { nullable: false, onDelete: "CASCADE" })
  @JoinColumn({ name: "project_id" }) project: Project;
  @Index() @Column({ name: "service_id", type: "uuid" }) serviceId: string;
  @ManyToOne(() => ProjectDeployableService, { nullable: false, onDelete: "CASCADE" })
  @JoinColumn({ name: "service_id" }) service: ProjectDeployableService;
  @Index() @Column({ name: "created_by_operation_id", type: "uuid" }) createdByOperationId: string;
  @Column({ name: "environment_name", length: 64 }) environmentName: string;
  @Column({ name: "configuration_fingerprint", length: 64 }) configurationFingerprint: string;
  @Column({ name: "non_secret_environment", type: "jsonb", default: {} }) nonSecretEnvironment: Record<string, string>;
  @Column({ name: "secret_references", type: "jsonb", default: {} }) secretReferences: Record<string, string>;
  @Column({ name: "secret_version_ids", type: "jsonb", default: {} }) secretVersionIds: Record<string, string>;
  @Column({ name: "database_configuration", type: "jsonb", default: {} }) databaseConfiguration: Record<string, unknown>;
  @Column({ name: "platform_values", type: "jsonb", default: {} }) platformValues: Record<string, string>;
  @Column({ name: "is_rollback_safe", default: true }) isRollbackSafe: boolean;
  @Column({ name: "legacy_backfill", default: false }) legacyBackfill: boolean;
  @Column({ name: "sealed_at", type: "timestamptz", nullable: true }) sealedAt: Date | null;
  @CreateDateColumn({ name: "created_at", type: "timestamptz" }) createdAt: Date;
}
