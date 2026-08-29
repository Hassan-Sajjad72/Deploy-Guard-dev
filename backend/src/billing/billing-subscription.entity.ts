import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from "typeorm";

@Entity("billing_subscriptions")
export class BillingSubscription {
  @PrimaryGeneratedColumn("uuid") id: string;
  @Index({ unique: true }) @Column({ name: "user_id" }) userId: number;
  @Index({ unique: true }) @Column({ nullable: true, name: "provider_subscription_id" }) providerSubscriptionId: string | null;
  @Column({ default: "free" }) plan: string;
  @Column({ default: "active" }) status: string;
  @Column({ default: "none" }) provider: string;
  @Column({ default: "not_configured" }) mode: string;
  @Column({ nullable: true, name: "billing_period_start", type: "timestamptz" }) billingPeriodStart: Date | null;
  @Column({ nullable: true, name: "billing_period_end", type: "timestamptz" }) billingPeriodEnd: Date | null;
  @Column({ default: false, name: "cancel_at_period_end" }) cancelAtPeriodEnd: boolean;
  @Column({ nullable: true, name: "cancelled_at", type: "timestamptz" }) cancelledAt: Date | null;
  @Column({ nullable: true, name: "provider_event_created_at", type: "timestamptz" }) providerEventCreatedAt: Date | null;
  @CreateDateColumn({ name: "created_at", type: "timestamptz" }) createdAt: Date;
  @UpdateDateColumn({ name: "updated_at", type: "timestamptz" }) updatedAt: Date;
}
