import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from "typeorm";

@Entity("ai_analysis_results")
export class AiAnalysisResult {
  @PrimaryGeneratedColumn("uuid") id: string;
  @Index() @Column({ name: "session_id", type: "uuid" }) sessionId: string;
  @Column({ type: "text" }) summary: string;
  @Column({ type: "text", name: "root_cause" }) rootCause: string;
  @Column({ type: "text", name: "technical_details" }) technicalDetails: string;
  @Column({ type: "jsonb", name: "remediation_steps" }) remediationSteps: string[];
  @Column({ type: "jsonb", name: "evidence_references" }) evidenceReferences: Array<Record<string, unknown>>;
  @Column({ type: "text" }) limitations: string;
  @Column({ type: "decimal", precision: 4, scale: 3, default: () => "0.5" }) confidence: number;
  @Column({ default: "fallback", name: "result_mode" }) resultMode: string;
  @Column({ default: 1 }) revision: number;
  @CreateDateColumn({ name: "created_at", type: "timestamptz" }) createdAt: Date;
}
