import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from "typeorm";

@Entity("billing_usage_counters")
@Index("UQ_billing_usage_counters_legacy_scope", ["userId", "metric", "periodStart"], { unique: true, where: '"organization_id" IS NULL' })
@Index("UQ_billing_usage_counters_organization_scope", ["organizationId", "metric", "periodStart"], { unique: true, where: '"organization_id" IS NOT NULL' })
export class BillingUsageCounter {
  @PrimaryGeneratedColumn("uuid") id: string;
  @Index() @Column({ name: "organization_id", type: "uuid", nullable: true }) organizationId: string | null;
  @Index() @Column({ name: "user_id" }) userId: number;
  @Column() metric: string;
  @Column({ name: "period_start", type: "date" }) periodStart: string;
  @Column({ name: "period_end", type: "date" }) periodEnd: string;
  @Column({ default: 0 }) quantity: number;
  @CreateDateColumn({ name: "created_at", type: "timestamptz" }) createdAt: Date;
  @UpdateDateColumn({ name: "updated_at", type: "timestamptz" }) updatedAt: Date;
}
