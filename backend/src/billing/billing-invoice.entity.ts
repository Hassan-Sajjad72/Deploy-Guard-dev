import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from "typeorm";

@Entity("billing_invoices")
export class BillingInvoice {
  @PrimaryGeneratedColumn("uuid") id: string;
  @Index() @Column({ name: "user_id" }) userId: number;
  @Index({ unique: true }) @Column({ name: "provider_invoice_id" }) providerInvoiceId: string;
  @Column() status: string;
  @Column({ name: "amount_due", type: "integer", default: 0 }) amountDue: number;
  @Column({ default: "usd" }) currency: string;
  @Column({ nullable: true, name: "hosted_invoice_url" }) hostedInvoiceUrl: string | null;
  @Column({ nullable: true, name: "invoice_pdf_url" }) invoicePdfUrl: string | null;
  @Column({ nullable: true, name: "issued_at", type: "timestamptz" }) issuedAt: Date | null;
  @Column({ nullable: true, name: "provider_event_created_at", type: "timestamptz" }) providerEventCreatedAt: Date | null;
  @CreateDateColumn({ name: "created_at", type: "timestamptz" }) createdAt: Date;
}
