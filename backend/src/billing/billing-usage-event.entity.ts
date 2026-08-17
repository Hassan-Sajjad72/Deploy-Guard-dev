import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from "typeorm";

@Entity("billing_usage_events")
export class BillingUsageEvent {
  @PrimaryGeneratedColumn("uuid") id: string;
  @Index() @Column({ name: "user_id" }) userId: number;
  @Column() metric: string;
  @Index({ unique: true }) @Column({ name: "idempotency_key" }) idempotencyKey: string;
  @Column({ default: 1 }) quantity: number;
  @Column({ name: "period_start", type: "date" }) periodStart: string;
  @Column({ nullable: true, type: "jsonb" }) metadata: Record<string, unknown> | null;
  @CreateDateColumn({ name: "created_at", type: "timestamptz" }) createdAt: Date;
}
