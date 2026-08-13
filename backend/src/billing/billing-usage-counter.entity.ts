import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, Unique, UpdateDateColumn } from "typeorm";

@Entity("billing_usage_counters")
@Unique(["userId", "metric", "periodStart"])
export class BillingUsageCounter {
  @PrimaryGeneratedColumn("uuid") id: string;
  @Index() @Column({ name: "user_id" }) userId: number;
  @Column() metric: string;
  @Column({ name: "period_start", type: "date" }) periodStart: string;
  @Column({ name: "period_end", type: "date" }) periodEnd: string;
  @Column({ default: 0 }) quantity: number;
  @CreateDateColumn({ name: "created_at", type: "timestamptz" }) createdAt: Date;
  @UpdateDateColumn({ name: "updated_at", type: "timestamptz" }) updatedAt: Date;
}
