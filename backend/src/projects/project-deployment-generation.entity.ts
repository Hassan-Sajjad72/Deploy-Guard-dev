import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryColumn, Unique, UpdateDateColumn } from "typeorm";
import { Project } from "./project.entity";

export enum DeploymentGenerationStatus {
  DEPLOYING = "deploying",
  LIVE = "live",
  FAILED = "failed",
  RETIRED = "retired",
  CLEANUP_PENDING = "cleanup_pending",
  CLEANED = "cleaned",
}

@Entity("project_deployment_generations")
@Unique("UQ_project_deployment_generation_ordinal", ["projectId", "environmentName", "ordinal"])
@Index("UQ_project_deployment_generation_live", ["projectId", "environmentName"], {
  unique: true,
  where: `"status" = 'live'`,
})
@Index("UQ_project_deployment_generation_candidate", ["projectId", "environmentName"], {
  unique: true,
  where: `"status" = 'deploying'`,
})
@Index("UQ_project_deployment_generation_candidate_listener_priority", ["candidateListenerPriority"], {
  unique: true,
  where: `"candidate_listener_priority" IS NOT NULL`,
})
export class ProjectDeploymentGeneration {
  @PrimaryColumn({ type: "uuid" }) id: string;
  @Index() @Column({ name: "project_id", type: "uuid" }) projectId: string;
  @ManyToOne(() => Project, { nullable: false, onDelete: "CASCADE" })
  @JoinColumn({ name: "project_id" }) project: Project;
  @Column({ name: "environment_name", length: 64 }) environmentName: string;
  @Column({ type: "integer" }) ordinal: number;
  @Column({ name: "candidate_listener_priority", type: "integer", nullable: true }) candidateListenerPriority: number | null;
  @Column({ default: DeploymentGenerationStatus.DEPLOYING }) status: DeploymentGenerationStatus;
  @Column({ name: "terraform_state_key" }) terraformStateKey: string;
  @Column({ name: "resource_manifest", type: "jsonb", default: {} }) resourceManifest: Record<string, unknown>;
  @Column({ name: "cleanup_metadata", type: "jsonb", default: {} }) cleanupMetadata: Record<string, unknown>;
  @Column({ nullable: true, name: "created_by_operation_id", type: "uuid" }) createdByOperationId: string | null;
  @Column({ nullable: true, name: "retired_by_operation_id", type: "uuid" }) retiredByOperationId: string | null;
  @Column({ nullable: true, name: "activated_at", type: "timestamptz" }) activatedAt: Date | null;
  @Column({ nullable: true, name: "retired_at", type: "timestamptz" }) retiredAt: Date | null;
  @Column({ nullable: true, name: "failed_at", type: "timestamptz" }) failedAt: Date | null;
  @Column({ nullable: true, name: "cleaned_at", type: "timestamptz" }) cleanedAt: Date | null;
  @Column({ type: "jsonb", default: {} }) metadata: Record<string, unknown>;
  @CreateDateColumn({ name: "created_at", type: "timestamptz" }) createdAt: Date;
  @UpdateDateColumn({ name: "updated_at", type: "timestamptz" }) updatedAt: Date;
}
