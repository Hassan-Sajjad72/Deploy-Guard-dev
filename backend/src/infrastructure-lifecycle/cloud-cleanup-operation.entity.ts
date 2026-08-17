import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from "typeorm";

@Entity("cloud_cleanup_operations")
export class CloudCleanupOperation {
  @PrimaryGeneratedColumn("uuid") id: string;
  @Index() @Column({ name: "user_id" }) userId: number;
  @Column() mode: string;
  @Index() @Column({ default: "running" }) status: string;
  @Column({ name: "resource_ids", type: "jsonb", default: [] }) resourceIds: string[];
  @Column({ type: "jsonb", nullable: true }) results: Array<Record<string, unknown>> | null;
  @Column({ name: "error_message", type: "text", nullable: true }) errorMessage: string | null;
  @Column({ name: "completed_at", type: "timestamptz", nullable: true }) completedAt: Date | null;
  @CreateDateColumn({ name: "created_at", type: "timestamptz" }) createdAt: Date;
  @UpdateDateColumn({ name: "updated_at", type: "timestamptz" }) updatedAt: Date;
}
