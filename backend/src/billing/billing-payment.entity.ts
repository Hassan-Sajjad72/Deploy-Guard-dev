import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from "typeorm";

@Entity("billing_payments")
export class BillingPayment {
  @PrimaryGeneratedColumn("uuid") id: string;
  @Index() @Column({ name: "user_id" }) userId: number;
  @Index({ unique: true }) @Column({ name: "provider_transaction_id" }) providerTransactionId: string;
  @Index() @Column({ nullable: true, name: "checkout_session_id", type: "uuid" }) checkoutSessionId: string | null;
  @Column({ default: "stripe" }) provider: string;
  @Column({ default: "test" }) mode: string;
  @Column() plan: string;
  @Column({ default: "paid" }) status: string;
  @Column({ type: "integer" }) amount: number;
  @Column({ default: "USD" }) currency: string;
  @Column({ name: "paid_at", type: "timestamptz" }) paidAt: Date;
  @Column({ nullable: true, name: "safe_metadata", type: "jsonb" }) safeMetadata: Record<string, unknown> | null;
  @CreateDateColumn({ name: "created_at", type: "timestamptz" }) createdAt: Date;
}
