import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, Unique, UpdateDateColumn } from "typeorm";

@Entity("notification_subscriptions")
@Unique(["userId", "projectId", "destination"])
export class NotificationSubscription {
  @PrimaryGeneratedColumn("uuid") id: string;
  @Index() @Column({ name: "user_id" }) userId: number;
  @Index() @Column({ name: "project_id", type: "uuid" }) projectId: string;
  @Column() destination: string;
  @Column({ default: "email" }) protocol: string;
  @Column({ default: "unconfigured" }) status: string;
  @Column({ nullable: true, name: "provider_subscription_arn" }) providerSubscriptionArn: string | null;
  @Column({ nullable: true, name: "provider_topic_arn" }) providerTopicArn: string | null;
  @Column({ nullable: true, name: "confirmed_at", type: "timestamptz" }) confirmedAt: Date | null;
  @Column({ nullable: true, name: "last_error", type: "text" }) lastError: string | null;
  @CreateDateColumn({ name: "created_at", type: "timestamptz" }) createdAt: Date;
  @UpdateDateColumn({ name: "updated_at", type: "timestamptz" }) updatedAt: Date;
}
