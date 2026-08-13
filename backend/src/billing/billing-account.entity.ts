import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from "typeorm";

@Entity("billing_accounts")
export class BillingAccount {
  @PrimaryGeneratedColumn("uuid") id: string;
  @Index({ unique: true }) @Column({ name: "user_id" }) userId: number;
  @Index({ unique: true }) @Column({ nullable: true, name: "provider_customer_id" }) providerCustomerId: string | null;
  @Column({ default: "none" }) provider: string;
  @Column({ default: "not_configured" }) mode: string;
  @Column({ nullable: true, name: "payment_brand" }) paymentBrand: string | null;
  @Column({ nullable: true, name: "payment_last4" }) paymentLast4: string | null;
  @Column({ nullable: true, name: "payment_exp_month" }) paymentExpMonth: number | null;
  @Column({ nullable: true, name: "payment_exp_year" }) paymentExpYear: number | null;
  @CreateDateColumn({ name: "created_at", type: "timestamptz" }) createdAt: Date;
  @UpdateDateColumn({ name: "updated_at", type: "timestamptz" }) updatedAt: Date;
}
