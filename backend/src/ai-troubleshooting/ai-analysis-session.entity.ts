import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from "typeorm";

@Entity("ai_analysis_sessions")
export class AiAnalysisSession {
  @PrimaryGeneratedColumn("uuid") id: string;
  @Index() @Column({ name: "user_id" }) userId: number;
  @Index() @Column({ name: "project_id", type: "uuid" }) projectId: string;
  @Index() @Column({ name: "pipeline_run_id", type: "uuid" }) pipelineRunId: string;
  @Column({ default: "pending" }) status: string;
  @Column({ nullable: true }) provider: string | null;
  @Column({ nullable: true }) model: string | null;
  @Column({ default: "unavailable", name: "provider_mode" }) providerMode: string;
  @Column({ nullable: true, name: "initial_context", type: "jsonb" }) initialContext: Record<string, unknown> | null;
  @Column({ nullable: true, name: "last_error" }) lastError: string | null;
  @Column({ nullable: true, name: "closed_at", type: "timestamptz" }) closedAt: Date | null;
  @CreateDateColumn({ name: "created_at", type: "timestamptz" }) createdAt: Date;
  @UpdateDateColumn({ name: "updated_at", type: "timestamptz" }) updatedAt: Date;
}
