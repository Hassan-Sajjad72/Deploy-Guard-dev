import { Column, CreateDateColumn, Entity, Index, PrimaryColumn } from "typeorm";

@Entity("operational_intelligence_records")
@Index(["projectId", "kind", "createdAt"])
export class IntelligenceRecord {
  @PrimaryColumn("uuid") id: string;
  @Column({ name: "project_id", type: "uuid" }) projectId: string;
  @Column({ name: "organization_id", type: "uuid", nullable: true }) organizationId: string | null;
  @Column({ length: 32 }) kind: "incident" | "api_contract" | "api_run" | "optimization";
  @Column({ length: 64 }) fingerprint: string;
  @Column({ type: "jsonb" }) content: Record<string, any>;
  @Column({ name: "created_by_user_id", type: "integer" }) createdByUserId: number;
  @CreateDateColumn({ name: "created_at", type: "timestamptz" }) createdAt: Date;
}
