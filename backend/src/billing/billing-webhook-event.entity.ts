import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from "typeorm";

@Entity("billing_webhook_events")
export class BillingWebhookEvent {
  @PrimaryGeneratedColumn("uuid") id: string;
  @Index({ unique: true }) @Column({ name: "provider_event_id" }) providerEventId: string;
  @Column() provider: string;
  @Column({ name: "event_type" }) eventType: string;
  @Column({ default: "received" }) status: string;
  @Column({ nullable: true, name: "occurred_at", type: "timestamptz" }) occurredAt: Date | null;
  @Column({ nullable: true, name: "processed_at", type: "timestamptz" }) processedAt: Date | null;
  @Column({ nullable: true, name: "safe_metadata", type: "jsonb" }) safeMetadata: Record<string, unknown> | null;
  @CreateDateColumn({ name: "created_at", type: "timestamptz" }) createdAt: Date;
}
