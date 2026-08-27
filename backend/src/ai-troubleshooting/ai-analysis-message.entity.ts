import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from "typeorm";

@Entity("ai_analysis_messages")
export class AiAnalysisMessage {
  @PrimaryGeneratedColumn("uuid") id: string;
  @Index() @Column({ name: "session_id", type: "uuid" }) sessionId: string;
  @Column() role: string;
  @Column({ type: "text" }) content: string;
  @Column({ nullable: true, name: "usage_metadata", type: "jsonb" }) usageMetadata: Record<string, unknown> | null;
  @CreateDateColumn({ name: "created_at", type: "timestamptz" }) createdAt: Date;
}
