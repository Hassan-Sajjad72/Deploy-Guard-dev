import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, Unique, UpdateDateColumn } from "typeorm";

@Entity("notification_preferences")
@Unique(["userId", "projectId"])
export class NotificationPreference {
  @PrimaryGeneratedColumn("uuid") id: string;
  @Index() @Column({ name: "user_id" }) userId: number;
  @Index() @Column({ name: "project_id", type: "uuid" }) projectId: string;
  @Column({ default: false }) enabled: boolean;
  @Column({ default: true, name: "critical_enabled" }) criticalEnabled: boolean;
  @Column({ default: true, name: "success_enabled" }) successEnabled: boolean;
  @Column({ default: false, name: "stage_updates_enabled" }) stageUpdatesEnabled: boolean;
  @Column({ default: "email" }) channel: string;
  @CreateDateColumn({ name: "created_at", type: "timestamptz" }) createdAt: Date;
  @UpdateDateColumn({ name: "updated_at", type: "timestamptz" }) updatedAt: Date;
}
