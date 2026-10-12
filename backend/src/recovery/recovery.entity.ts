import { Column, CreateDateColumn, Entity, Index, PrimaryColumn } from "typeorm";

@Entity("governed_recovery_requests")
export class GovernedRecoveryRequest {
  @PrimaryColumn("uuid") id: string;
  @Index() @Column({ name: "project_id", type: "uuid" }) projectId: string;
  @Column({ name: "organization_id", type: "uuid", nullable: true }) organizationId: string | null;
  @Column({ name: "incident_id", type: "uuid" }) incidentId: string;
  @Column({ name: "created_by_user_id", type: "integer" }) createdByUserId: number;
  @Column({ length: 64 }) fingerprint: string;
  @Column({ type: "jsonb" }) content: Record<string, any>;
  @Column({ default: "requested" }) status: string;
  @Column({ name: "operation_id", type: "uuid", nullable: true }) operationId: string | null;
  @Column({ name: "started_at", type: "timestamptz", nullable: true }) startedAt: Date | null;
  @Column({ name: "completed_at", type: "timestamptz", nullable: true }) completedAt: Date | null;
  @Column({ type: "jsonb", nullable: true }) outcome: Record<string, any> | null;
  @CreateDateColumn({ name: "created_at", type: "timestamptz" }) createdAt: Date;
}
@Entity("governed_recovery_decisions")
export class GovernedRecoveryDecision {
  @PrimaryColumn({ name: "request_id", type: "uuid" }) requestId: string;
  @Column({ name: "actor_user_id", type: "integer" }) actorUserId: number;
  @Column({ name: "actor_role" }) actorRole: string;
  @Column({ length: 64 }) fingerprint: string;
  @Column() decision: "approved" | "rejected";
  @Column({ length: 1000 }) reason: string;
  @CreateDateColumn({ name: "created_at", type: "timestamptz" }) createdAt: Date;
}
@Entity("supervised_repair_proposals")
export class SupervisedRepairProposal {
  @PrimaryColumn("uuid") id: string;
  @Index() @Column({ name: "project_id", type: "uuid" }) projectId: string;
  @Column({ name: "organization_id", type: "uuid", nullable: true }) organizationId: string | null;
  @Column({ name: "created_by_user_id", type: "integer" }) createdByUserId: number;
  @Column({ length: 64 }) fingerprint: string;
  @Column({ type: "jsonb" }) content: Record<string, any>;
  @Column({ default: "unverified" }) status: string;
  @Column({ type: "jsonb", nullable: true }) checks: Record<string, any> | null;
  @Column({ name: "pull_request_url", nullable: true }) pullRequestUrl: string | null;
  @CreateDateColumn({ name: "created_at", type: "timestamptz" }) createdAt: Date;
}
