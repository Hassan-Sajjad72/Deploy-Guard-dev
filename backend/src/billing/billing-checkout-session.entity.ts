import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from "typeorm";

@Entity("billing_checkout_sessions")
export class BillingCheckoutSession {
  @PrimaryGeneratedColumn("uuid") id: string;
  @Index() @Column({ name: "user_id" }) userId: number;
  @Index({ unique: true }) @Column({ name: "provider_session_id" }) providerSessionId: string;
  @Column() provider: string;
  @Column() mode: string;
  @Column() plan: string;
  @Column({ default: "created" }) status: string;
  @Column({ nullable: true, name: "expires_at", type: "timestamptz" }) expiresAt: Date | null;
  @CreateDateColumn({ name: "created_at", type: "timestamptz" }) createdAt: Date;
}
