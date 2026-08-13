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
import { Project } from "../projects/project.entity";
import { User } from "../users/user.entity";
import { decimalTransformer } from "./decimal.transformer";

export enum SubscriptionTier {
  FREE = "free",
  STARTER = "starter",
  PRO = "pro",
  ENTERPRISE = "enterprise",
}

@Entity("project_cost_settings")
@Unique(["projectId"])
export class ProjectCostSettings {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Index()
  @Column({ name: "project_id" })
  projectId: string;

  @ManyToOne(() => Project, { nullable: false, onDelete: "CASCADE" })
  @JoinColumn({ name: "project_id" })
  project: Project;

  @Column({ name: "subscription_tier", type: "enum", enum: SubscriptionTier, default: SubscriptionTier.FREE })
  subscriptionTier: SubscriptionTier;

  @Column({ name: "warning_threshold_monthly_cost", type: "numeric", precision: 12, scale: 2, default: 25, transformer: decimalTransformer })
  warningThresholdMonthlyCost: number;

  @Column({ default: "USD" })
  currency: string;

  @Column({ nullable: true, name: "updated_by_user_id" })
  updatedByUserId: number;

  @ManyToOne(() => User, { nullable: true, onDelete: "SET NULL" })
  @JoinColumn({ name: "updated_by_user_id" })
  updatedByUser: User;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt: Date;

  @UpdateDateColumn({ name: "updated_at", type: "timestamptz" })
  updatedAt: Date;
}
