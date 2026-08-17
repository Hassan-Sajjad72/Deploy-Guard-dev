import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from "typeorm";
import { ProjectPipelineRun } from "../projects/project-pipeline-run.entity";
import { Project } from "../projects/project.entity";
import { User } from "../users/user.entity";
import { decimalTransformer } from "./decimal.transformer";
import { ProjectCostResourceBreakdown } from "./project-cost-resource-breakdown.entity";

export enum CostEstimateStatus {
  PENDING = "pending",
  CALCULATING = "calculating",
  NO_APPROVAL_REQUIRED = "no_approval_required",
  APPROVAL_REQUIRED = "approval_required",
  APPROVED = "approved",
  REJECTED = "rejected",
  BLOCKED_BY_TIER_LIMIT = "blocked_by_tier_limit",
  WARNING_OVER_TIER = "warning_over_tier",
  FAILED = "failed",
}

export enum CostEstimateSource {
  MOCK = "mock",
  INFRACOST = "infracost",
}

@Entity("project_cost_estimates")
export class ProjectCostEstimate {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Index()
  @Column({ name: "project_id" })
  projectId: string;

  @ManyToOne(() => Project, { nullable: false, onDelete: "CASCADE" })
  @JoinColumn({ name: "project_id" })
  project: Project;

  @Index()
  @Column({ nullable: true, name: "generation_id", type: "uuid" })
  generationId: string | null;

  @Column({ default: "dev", name: "environment_name" })
  environmentName: string;

  @Index()
  @Column({ nullable: true, name: "pipeline_run_id" })
  pipelineRunId: string;

  @ManyToOne(() => ProjectPipelineRun, { nullable: true, onDelete: "SET NULL" })
  @JoinColumn({ name: "pipeline_run_id" })
  pipelineRun: ProjectPipelineRun;

  @Column({ nullable: true, name: "created_by_user_id" })
  createdByUserId: number;

  @ManyToOne(() => User, { nullable: true, onDelete: "SET NULL" })
  @JoinColumn({ name: "created_by_user_id" })
  createdByUser: User;

  @Column({ type: "enum", enum: CostEstimateStatus, default: CostEstimateStatus.PENDING })
  status: CostEstimateStatus;

  @Column({ type: "enum", enum: CostEstimateSource })
  source: CostEstimateSource;

  @Column({ default: "USD" })
  currency: string;

  @Column({ name: "total_monthly_cost", type: "numeric", precision: 12, scale: 2, default: 0, transformer: decimalTransformer })
  totalMonthlyCost: number;

  @Column({ nullable: true, name: "previous_monthly_cost", type: "numeric", precision: 12, scale: 2, transformer: decimalTransformer })
  previousMonthlyCost: number;

  @Column({ nullable: true, name: "monthly_cost_difference", type: "numeric", precision: 12, scale: 2, transformer: decimalTransformer })
  monthlyCostDifference: number;

  @Column({ nullable: true, name: "tier_limit_monthly_cost", type: "numeric", precision: 12, scale: 2, transformer: decimalTransformer })
  tierLimitMonthlyCost: number;

  @Column({ nullable: true, name: "warning_threshold_monthly_cost", type: "numeric", precision: 12, scale: 2, transformer: decimalTransformer })
  warningThresholdMonthlyCost: number;

  @Column({ name: "subscription_tier" })
  subscriptionTier: string;

  @Column({ default: false, name: "approval_required" })
  approvalRequired: boolean;

  @Column({ default: false, name: "blocked_by_tier_limit" })
  blockedByTierLimit: boolean;

  @Column({ nullable: true, name: "upgrade_prompt_message", type: "text" })
  upgradePromptMessage: string;

  @Column({ nullable: true, name: "terraform_plan_summary", type: "jsonb" })
  terraformPlanSummary: Record<string, unknown> | null;

  @Column({ nullable: true, name: "raw_infracost_response", type: "jsonb" })
  rawInfracostResponse: Record<string, unknown> | null;

  @Column({ nullable: true, name: "normalized_breakdown", type: "jsonb" })
  normalizedBreakdown: Record<string, unknown> | null;

  @Column({ nullable: true, type: "jsonb" })
  metadata: Record<string, unknown> | null;

  @Column({ nullable: true, name: "error_message", type: "text" })
  errorMessage: string;

  @Column({ nullable: true, name: "approved_by_user_id" })
  approvedByUserId: number;

  @Column({ nullable: true, name: "approved_at", type: "timestamptz" })
  approvedAt: Date;

  @Column({ nullable: true, name: "rejected_by_user_id" })
  rejectedByUserId: number;

  @Column({ nullable: true, name: "rejected_at", type: "timestamptz" })
  rejectedAt: Date;

  @Column({ nullable: true, name: "rejection_reason", type: "text" })
  rejectionReason: string;

  @OneToMany(() => ProjectCostResourceBreakdown, (breakdown) => breakdown.estimate)
  breakdowns: ProjectCostResourceBreakdown[];

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt: Date;

  @UpdateDateColumn({ name: "updated_at", type: "timestamptz" })
  updatedAt: Date;
}
