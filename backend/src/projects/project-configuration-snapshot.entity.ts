import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn, Unique } from "typeorm";
import { ProjectPipelineRun } from "./project-pipeline-run.entity";
import { Project } from "./project.entity";

@Entity("project_configuration_snapshots")
@Unique(["pipelineRunId"])
export class ProjectConfigurationSnapshot {
  @PrimaryGeneratedColumn("uuid") id: string;
  @Index() @Column({ name: "project_id" }) projectId: string;
  @ManyToOne(() => Project, { nullable: false, onDelete: "CASCADE" })
  @JoinColumn({ name: "project_id" }) project: Project;
  @Index() @Column({ name: "pipeline_run_id" }) pipelineRunId: string;
  @ManyToOne(() => ProjectPipelineRun, { nullable: false, onDelete: "CASCADE" })
  @JoinColumn({ name: "pipeline_run_id" }) pipelineRun: ProjectPipelineRun;
  @Column({ default: "dev" }) environment: string;
  @Index() @Column({ name: "configuration_fingerprint" }) configurationFingerprint: string;
  @Column({ type: "jsonb", default: {}, name: "plain_values" }) plainValues: Record<string, string>;
  @Column({ type: "jsonb", default: {}, name: "build_values" }) buildValues: Record<string, string>;
  @Column({ type: "jsonb", default: {}, name: "secret_references" }) secretReferences: Record<string, string>;
  @Column({ type: "jsonb", default: [], name: "binding_revisions" }) bindingRevisions: Array<Record<string, unknown>>;
  @Column({ type: "jsonb", default: {}, name: "ownership_manifest" }) ownershipManifest: Record<string, Record<string, unknown>>;
  @Column({ type: "jsonb", default: {}, name: "source_revisions" }) sourceRevisions: Record<string, string>;
  @Column({ type: "jsonb", default: [], name: "unresolved_required" }) unresolvedRequired: string[];
  @Column({ type: "jsonb", default: [], name: "prohibited_overrides" }) prohibitedOverrides: string[];
  @Column({ type: "jsonb", default: [], name: "duplicate_conflicts" }) duplicateConflicts: string[];
  @Column({ type: "jsonb", default: [], name: "validation_blockers" }) validationBlockers: string[];
  @Column({ type: "text", select: false, nullable: true, name: "encrypted_secret_payload" }) encryptedSecretPayload: string | null;
  @Column({ type: "jsonb", default: {}, name: "sanitized_manifest" }) sanitizedManifest: Record<string, unknown>;
  @CreateDateColumn({ name: "created_at", type: "timestamptz" }) createdAt: Date;
}
