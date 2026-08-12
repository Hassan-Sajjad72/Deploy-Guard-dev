import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn, UpdateDateColumn } from "typeorm";
import { Project } from "./project.entity";
import { ProjectDeploymentGeneration } from "./project-deployment-generation.entity";

export enum ProjectDestroyPhase {
  AWS_CLEANUP = "AWS_CLEANUP",
  AWS_VERIFIED = "AWS_VERIFIED",
  TERRAFORM_STATE_CLEANUP = "TERRAFORM_STATE_CLEANUP",
  EXTERNAL_METADATA_CLEANUP = "EXTERNAL_METADATA_CLEANUP",
  DATABASE_EXTINCTION = "DATABASE_EXTINCTION",
  FINAL_404_VERIFY = "FINAL_404_VERIFY",
  EXTINCT = "EXTINCT",
}

export enum ProjectDestroyStatus {
  DELETING = "DELETING",
  DESTROYING = "DESTROYING",
  DESTROY_VERIFYING = "DESTROY_VERIFYING",
  DESTROY_INCOMPLETE = "DESTROY_INCOMPLETE",
  DESTROYED = "DESTROYED",
  EXTINCT = "EXTINCT",
}

export type DestroyRemainingResource = {
  resourceType: string;
  resourceId: string;
  ownershipScope: "generation" | "project" | "platform_shared";
  reason: string;
  errorCode?: string;
  errorMessage?: string;
  retryable: boolean;
  attemptCount: number;
  firstSeenAt: string;
  lastSeenAt: string;
  nextRetryAt?: string;
};

@Entity("project_destroy_lifecycles")
@Index("UQ_project_destroy_lifecycle_scope", ["projectId", "environmentName"], { unique: true })
export class ProjectDestroyLifecycle {
  @PrimaryGeneratedColumn("uuid") id: string;
  @Index() @Column({ name: "project_id", type: "uuid" }) projectId: string;
  @ManyToOne(() => Project, { nullable: false, onDelete: "CASCADE" })
  @JoinColumn({ name: "project_id" }) project: Project;
  @Index() @Column({ name: "generation_id", type: "uuid" }) generationId: string;
  @ManyToOne(() => ProjectDeploymentGeneration, { nullable: false, onDelete: "CASCADE" })
  @JoinColumn({ name: "generation_id" }) generation: ProjectDeploymentGeneration;
  @Index() @Column({ name: "operation_id", type: "uuid" }) operationId: string;
  @Column({ name: "environment_name", length: 64 }) environmentName: string;
  @Column({ type: "varchar", length: 32, default: ProjectDestroyStatus.DELETING }) status: ProjectDestroyStatus;
  @Column({ type: "varchar", length: 40, default: ProjectDestroyPhase.AWS_CLEANUP }) phase: ProjectDestroyPhase;
  @Column({ name: "resource_manifest", type: "jsonb", default: {} }) resourceManifest: Record<string, unknown>;
  @Column({ type: "jsonb", default: [] }) remaining: DestroyRemainingResource[];
  @Column({ name: "terraform_evidence", type: "jsonb", default: {} }) terraformEvidence: Record<string, unknown>;
  @Column({ name: "verification_evidence", type: "jsonb", default: {} }) verificationEvidence: Record<string, unknown>;
  @Column({ name: "lease_owner", nullable: true, type: "varchar", length: 160 }) leaseOwner: string | null;
  @Column({ name: "lease_expires_at", nullable: true, type: "timestamptz" }) leaseExpiresAt: Date | null;
  @Column({ name: "heartbeat_at", nullable: true, type: "timestamptz" }) heartbeatAt: Date | null;
  @Column({ name: "retry_count", type: "integer", default: 0 }) retryCount: number;
  @Column({ name: "next_retry_at", nullable: true, type: "timestamptz" }) nextRetryAt: Date | null;
  @Column({ name: "first_started_at", type: "timestamptz", default: () => "CURRENT_TIMESTAMP" }) firstStartedAt: Date;
  @Column({ name: "last_attempt_at", type: "timestamptz", default: () => "CURRENT_TIMESTAMP" }) lastAttemptAt: Date;
  @Column({ name: "escalation", type: "jsonb", nullable: true }) escalation: Record<string, unknown> | null;
  @CreateDateColumn({ name: "created_at", type: "timestamptz" }) createdAt: Date;
  @UpdateDateColumn({ name: "updated_at", type: "timestamptz" }) updatedAt: Date;
}
