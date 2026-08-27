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
import { Project } from "./project.entity";

export type DeploymentRequirementsStatus = "needs_input" | "ready" | "saved" | "applied" | "invalid";
export type DeploymentRequirementsApplicationStatus =
  | "detected"
  | "needs_input"
  | "saved"
  | "pending_deployment"
  | "applying"
  | "applied"
  | "verified";

@Entity("project_deployment_requirements")
@Unique(["projectId"])
export class ProjectDeploymentRequirements {
  @PrimaryGeneratedColumn("uuid") id: string;
  @Index() @Column({ name: "project_id" }) projectId: string;
  @ManyToOne(() => Project, { nullable: false, onDelete: "CASCADE" })
  @JoinColumn({ name: "project_id" }) project: Project;
  @Column({ nullable: true, name: "source_commit" }) sourceCommit: string | null;
  @Column({ nullable: true, name: "scan_revision" }) scanRevision: string | null;
  @Column({ default: "needs_input" }) status: DeploymentRequirementsStatus;
  @Column({ default: "detected", name: "application_status" }) applicationStatus: DeploymentRequirementsApplicationStatus;
  @Column({ type: "jsonb", default: {} }) architecture: Record<string, unknown>;
  @Column({ type: "jsonb", default: [], name: "required_inputs" }) requiredInputs: Array<Record<string, unknown>>;
  @Column({ type: "jsonb", default: [], name: "managed_bindings" }) managedBindings: Array<Record<string, unknown>>;
  @Column({ type: "jsonb", default: {} }) database: Record<string, unknown>;
  @Column({ type: "jsonb", default: [] }) blockers: string[];
  @Column({ default: false, name: "ready_to_resume" }) readyToResume: boolean;
  @Column({ nullable: true, name: "resume_from_stage" }) resumeFromStage: string | null;
  @Column({ type: "jsonb", default: [], name: "resume_sequence" }) resumeSequence: string[];
  @Column({ default: 1, name: "configuration_revision" }) configurationRevision: number;
  @Column({ nullable: true, name: "applied_pipeline_run_id", type: "uuid" }) appliedPipelineRunId: string | null;
  @Column({ nullable: true, type: "timestamptz", name: "saved_at" }) savedAt: Date | null;
  @Column({ nullable: true, type: "timestamptz", name: "applied_at" }) appliedAt: Date | null;
  @Column({ nullable: true, type: "timestamptz", name: "verified_at" }) verifiedAt: Date | null;
  @CreateDateColumn({ name: "created_at", type: "timestamptz" }) createdAt: Date;
  @UpdateDateColumn({ name: "updated_at", type: "timestamptz" }) updatedAt: Date;
}
