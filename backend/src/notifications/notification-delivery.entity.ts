import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from "typeorm";

@Entity("notification_deliveries")
export class NotificationDelivery {
  @PrimaryGeneratedColumn("uuid") id: string;
  @Index() @Column({ name: "user_id" }) userId: number;
  @Index() @Column({ name: "project_id", nullable: true, type: "uuid" }) projectId: string | null;
  @Column({ nullable: true, name: "pipeline_run_id", type: "uuid" }) pipelineRunId: string | null;
  @Column({ name: "event_type" }) eventType: string;
  @Index({ unique: true }) @Column({ name: "deduplication_key" }) deduplicationKey: string;
  @Column({ default: "pending" }) status: string;
  @Column({ nullable: true, name: "provider_message_id" }) providerMessageId: string | null;
  @Column({ default: 0 }) attempts: number;
  @Column({ nullable: true, name: "last_error" }) lastError: string | null;
  @Column({ name: "subject" }) subject: string;
  @Column({ type: "text" }) message: string;
  @Column({ nullable: true, name: "safe_metadata", type: "jsonb" }) safeMetadata: Record<string, unknown> | null;
  @Column({ nullable: true, name: "sent_at", type: "timestamptz" }) sentAt: Date | null;
  @CreateDateColumn({ name: "created_at", type: "timestamptz" }) createdAt: Date;
  @UpdateDateColumn({ name: "updated_at", type: "timestamptz" }) updatedAt: Date;
}
