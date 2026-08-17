import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from "typeorm";
import { ProjectPipelineRun } from "./project-pipeline-run.entity";
import { Project } from "./project.entity";
import { ManagedDatabaseEngine } from "./managed-database-engine";

export enum ServiceBindingStatus {
  PENDING = "pending",
  PROVISIONING = "provisioning",
  READY = "ready",
  APPLIED = "applied",
  VERIFIED = "verified",
  FAILED = "failed",
}

@Entity("project_service_bindings")
@Unique(["projectId", "pipelineRunId", "serviceType"])
export class ProjectServiceBinding {
  @PrimaryGeneratedColumn("uuid") id: string;
  @Index() @Column({ name: "project_id" }) projectId: string;
  @ManyToOne(() => Project, { nullable: false, onDelete: "CASCADE" })
  @JoinColumn({ name: "project_id" }) project: Project;
  @Index("IDX_service_bindings_generation") @Column({ nullable: true, name: "generation_id", type: "uuid" }) generationId: string | null;
  @Index() @Column({ name: "pipeline_run_id" }) pipelineRunId: string;
  @ManyToOne(() => ProjectPipelineRun, { nullable: false, onDelete: "CASCADE" })
  @JoinColumn({ name: "pipeline_run_id" }) pipelineRun: ProjectPipelineRun;
  @Column({ name: "service_type", default: "database" }) serviceType: "database";
  @Column() provider: "managed" | "external";
  @Column() engine: ManagedDatabaseEngine;
  @Column({ default: ServiceBindingStatus.PENDING }) status: ServiceBindingStatus;
  @Column({ name: "database_name" }) databaseName: string;
  @Column({ name: "host_reference" }) hostReference: string;
  @Column({ type: "integer" }) port: number;
  @Column({ nullable: true, name: "username_reference" }) usernameReference: string | null;
  @Column({ nullable: true, name: "username_secret_reference" }) usernameSecretReference: string | null;
  @Column({ nullable: true, name: "password_secret_reference" }) passwordSecretReference: string | null;
  @Column({ nullable: true, name: "database_url_secret_reference" }) databaseUrlSecretReference: string | null;
  @Column({ nullable: true, name: "cloud_map_namespace" }) cloudMapNamespace: string | null;
  @Column({ nullable: true, name: "cloud_map_service_name" }) cloudMapServiceName: string | null;
  @Column({ nullable: true, name: "cloud_map_service_arn" }) cloudMapServiceArn: string | null;
  @Column({ nullable: true, name: "ecs_database_service_arn" }) ecsDatabaseServiceArn: string | null;
  @Column({ nullable: true, name: "efs_file_system_id" }) efsFileSystemId: string | null;
  @Column({ nullable: true, name: "efs_access_point_id" }) efsAccessPointId: string | null;
  @Column({ nullable: true, name: "terraform_output_revision" }) terraformOutputRevision: string | null;
  @Index() @Column({ name: "configuration_fingerprint" }) configurationFingerprint: string;
  @Column({ type: "jsonb", default: {}, name: "sanitized_manifest" }) sanitizedManifest: Record<string, unknown>;
  @Column({ nullable: true, name: "failure_reason" }) failureReason: string | null;
  @Column({ nullable: true, type: "timestamptz", name: "ready_at" }) readyAt: Date | null;
  @Column({ nullable: true, type: "timestamptz", name: "applied_at" }) appliedAt: Date | null;
  @Column({ nullable: true, type: "timestamptz", name: "verified_at" }) verifiedAt: Date | null;
  @CreateDateColumn({ name: "created_at", type: "timestamptz" }) createdAt: Date;
  @UpdateDateColumn({ name: "updated_at", type: "timestamptz" }) updatedAt: Date;
}
