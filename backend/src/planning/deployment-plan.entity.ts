import { Column, CreateDateColumn, Entity, Index, PrimaryColumn } from "typeorm";
import { DeploymentPlanContent } from "./deployment-plan";

@Entity("deployment_plans")
@Index(["projectId", "version"], { unique: true })
export class DeploymentPlan {
  @PrimaryColumn("uuid") id: string;
  @Column({ name: "project_id", type: "uuid" }) projectId: string;
  @Column({ name: "organization_id", type: "uuid" }) organizationId: string;
  @Column({ type: "integer" }) version: number;
  @Column({ name: "created_by_user_id", type: "integer" }) createdByUserId: number;
  @Column({ length: 64 }) fingerprint: string;
  @Column({ type: "jsonb" }) content: DeploymentPlanContent;
  @CreateDateColumn({ name: "created_at", type: "timestamptz" }) createdAt: Date;
}

@Entity("deployment_plan_decisions")
export class DeploymentPlanDecision {
  @PrimaryColumn({ name: "plan_id", type: "uuid" }) planId: string;
  @Column({ name: "actor_user_id", type: "integer" }) actorUserId: number;
  @Column({ name: "actor_role" }) actorRole: string;
  @Column({ name: "organization_id", type: "uuid" }) organizationId: string;
  @Column({ name: "project_id", type: "uuid" }) projectId: string;
  @Column() environment: string;
  @Column({ name: "operation_id", type: "uuid" }) operationId: string;
  @Column({ name: "monthly_budget_usd", type: "numeric", precision: 12, scale: 2 }) monthlyBudgetUsd: string;
  @Column() decision: "approved" | "rejected";
  @Column({ length: 64 }) fingerprint: string;
  @Column({ length: 1000 }) reason: string;
  @CreateDateColumn({ name: "created_at", type: "timestamptz" }) createdAt: Date;
}
