import { Column, CreateDateColumn, Entity, Index, JoinColumn, OneToOne, PrimaryGeneratedColumn, UpdateDateColumn } from "typeorm";
import { Project } from "../projects/project.entity";

@Entity("project_cloud_states")
export class ProjectCloudState {
  @PrimaryGeneratedColumn("uuid") id: string;
  @Index({ unique: true }) @Column({ name: "project_id" }) projectId: string;
  @OneToOne(() => Project, { nullable: false, onDelete: "CASCADE" }) @JoinColumn({ name: "project_id" }) project: Project;
  @Column({ name: "last_cloud_verified_at", type: "timestamptz", nullable: true }) lastCloudVerifiedAt: Date | null;
  @Column({ name: "cloud_verification_status", default: "verification_required" }) cloudVerificationStatus: string;
  @Column({ name: "last_verified_deployment_status", default: "unknown" }) lastVerifiedDeploymentStatus: string;
  @Column({ name: "last_verified_resource_status", default: "inventory_required" }) lastVerifiedResourceStatus: string;
  @Column({ name: "last_verified_health_status", default: "unknown" }) lastVerifiedHealthStatus: string;
  @Column({ name: "last_verified_infrastructure_status", default: "unknown" }) lastVerifiedInfrastructureStatus: string;
  @Column({ name: "last_verified_cleanup_status", default: "not_requested" }) lastVerifiedCleanupStatus: string;
  @Column({ name: "inventory_status", default: "not_scanned" }) inventoryStatus: string;
  @Column({ name: "admin_action_required", default: false }) adminActionRequired: boolean;
  @Column({ name: "next_action", default: "verify_cloud_state" }) nextAction: string;
  @Column({ name: "last_verification_reason", type: "text" }) lastVerificationReason: string;
  @Column({
    name: "last_inventory_scan_id",
    nullable: true,
    type: "uuid",
  })
  lastInventoryScanId: string | null;
  @Column({ type: "jsonb", default: {} }) evidence: Record<string, unknown>;
  @CreateDateColumn({ name: "created_at", type: "timestamptz" }) createdAt: Date;
  @UpdateDateColumn({ name: "updated_at", type: "timestamptz" }) updatedAt: Date;
}
