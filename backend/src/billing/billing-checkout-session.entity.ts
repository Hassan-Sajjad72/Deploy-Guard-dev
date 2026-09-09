import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from "typeorm";

@Entity("billing_checkout_sessions")
export class BillingCheckoutSession {
  @PrimaryGeneratedColumn("uuid") id: string;
  @Index() @Column({ name: "user_id" }) userId: number;
  @Index({ unique: true }) @Column({ name: "provider_session_id" }) providerSessionId: string;
  @Index({ unique: true }) @Column({ name: "merchant_order_id" }) merchantOrderId: string;
  @Column() provider: string;
  @Column() mode: string;
  @Column() plan: string;
  @Column({ default: "created" }) status: string;
  @Column({ name: "amount_due", type: "integer", default: 0 }) amountDue: number;
  @Column({ default: "USD" }) currency: string;
  @Index() @Column({ nullable: true, name: "provider_customer_id" }) providerCustomerId: string | null;
  @Index() @Column({ nullable: true, name: "provider_subscription_id" }) providerSubscriptionId: string | null;
  @Column({ nullable: true, name: "provider_price_id" }) providerPriceId: string | null;
  @Column({ nullable: true, name: "expires_at", type: "timestamptz" }) expiresAt: Date | null;
  @CreateDateColumn({ name: "created_at", type: "timestamptz" }) createdAt: Date;
}
