import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from "typeorm";

@Entity("central_cloud_resources")
export class CentralCloudResource {
  @PrimaryGeneratedColumn("uuid") id: string;
  @Index({ unique: true }) @Column({ name: "resource_key", length: 700 }) resourceKey: string;
  @Column({ type: "text", nullable: true }) arn: string | null;
  @Column({ name: "resource_name", type: "text" }) resourceName: string;
  @Index() @Column({ name: "resource_type" }) resourceType: string;
  @Index() @Column({ name: "aws_service" }) awsService: string;
  @Index() @Column() region: string;
  @Index() @Column({ name: "project_id", nullable: true, type: "uuid" }) projectId: string | null;
  @Index() @Column({ name: "pipeline_run_id", nullable: true, type: "uuid" }) pipelineRunId: string | null;
  @Column() source: string;
  @Column({ default: "unknown" }) ownership: string;
  @Column({ name: "cleanup_eligibility", default: "manual_review" }) cleanupEligibility: string;
  @Index() @Column() status: string;
  @Index() @Column({ name: "cost_risk" }) costRisk: string;
  @Column({ name: "safe_to_cleanup", default: false }) safeToCleanup: boolean;
  @Column({ name: "cleanup_supported", default: false }) cleanupSupported: boolean;
  @Column({ default: false }) protected: boolean;
  @Column({ type: "text" }) reason: string;
  @Column({ type: "jsonb", nullable: true }) metadata: Record<string, unknown> | null;
  @Column({ type: "jsonb", nullable: true }) tags: Record<string, string> | null;
  @Column({ name: "first_seen_at", type: "timestamptz" }) firstSeenAt: Date;
  @Index() @Column({ name: "last_seen_at", type: "timestamptz" }) lastSeenAt: Date;
  @Column({ name: "deleted_at", type: "timestamptz", nullable: true }) deletedAt: Date | null;
  @Column({ name: "manual_review_at", type: "timestamptz", nullable: true }) manualReviewAt: Date | null;
  @CreateDateColumn({ name: "created_at", type: "timestamptz" }) createdAt: Date;
  @UpdateDateColumn({ name: "updated_at", type: "timestamptz" }) updatedAt: Date;
}
