import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from "typeorm";

@Entity("emergency_cleanup_operations")
export class EmergencyCleanupOperation {
  @PrimaryGeneratedColumn("uuid") id: string;
  @Index() @Column({ name: "user_id" }) userId: number;
  @Index() @Column({ default: "queued" }) status: string;
  @Column({ name: "queue_job_id", nullable: true }) queueJobId: string | null;
  @Column({ name: "target_count", default: 0 }) targetCount: number;
  @Column({ name: "completed_count", default: 0 }) completedCount: number;
  @Column({ name: "failed_count", default: 0 }) failedCount: number;
  @Column({ type: "jsonb", default: [] }) targets: Array<Record<string, unknown>>;
  @Column({ name: "error_message", type: "text", nullable: true }) errorMessage: string | null;
  @Column({ name: "started_at", type: "timestamptz", nullable: true }) startedAt: Date | null;
  @Column({ name: "completed_at", type: "timestamptz", nullable: true }) completedAt: Date | null;
  @CreateDateColumn({ name: "created_at", type: "timestamptz" }) createdAt: Date;
  @UpdateDateColumn({ name: "updated_at", type: "timestamptz" }) updatedAt: Date;
}
