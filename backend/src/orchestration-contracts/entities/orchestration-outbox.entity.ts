import { Check, Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, Unique, UpdateDateColumn } from "typeorm";
import { DeployGuardWorkerEnvelopeV1 } from "../contracts/worker-envelope.types";

export type OutboxStatus = "pending" | "publishing" | "published" | "failed" | "dead_letter";

@Entity("orchestration_outbox")
@Unique(
  "UQ_orchestration_outbox_payload",
  ["intentId", "eventType", "payloadSha256"],
)
@Index("IDX_orchestration_outbox_dispatch", ["status", "availableAt"], { where: `"status" IN ('pending','failed')` })
@Index("IDX_orchestration_outbox_delivery_claim", ["status", "claimExpiresAt", "availableAt"])
@Check("CHK_orchestration_outbox_status", `"status" IN ('pending','publishing','published','failed','dead_letter')`)
@Check("CHK_orchestration_outbox_payload_hash", `"payload_sha256" ~ '^[0-9a-f]{64}$'`)
@Check("CHK_orchestration_outbox_claim_fencing", `"claim_fencing_token" >= 0`)
export class OrchestrationOutbox {
  @PrimaryGeneratedColumn("uuid") id: string;
  @Index("IDX_orchestration_outbox_intent") @Column({ name: "intent_id", type: "uuid" }) intentId: string;
  @Column({ name: "aggregate_type", length: 32 }) aggregateType: string;
  @Column({ name: "aggregate_id", type: "uuid" }) aggregateId: string;
  @Column({ name: "event_type", length: 64 }) eventType: string;
  @Column({ name: "worker_envelope", type: "jsonb" }) workerEnvelope: DeployGuardWorkerEnvelopeV1;
  @Column({ name: "payload_sha256", type: "char", length: 64 }) payloadSha256: string;
  @Column({ type: "varchar", length: 24, default: "pending" }) status: OutboxStatus;
  @Column({ name: "attempt_count", type: "integer", default: 0 }) attemptCount: number;
  @Column({ name: "available_at", type: "timestamptz", default: () => "now()" }) availableAt: Date;
  @Column({ name: "claimed_by", nullable: true }) claimedBy: string | null;
  @Column({ name: "claim_expires_at", type: "timestamptz", nullable: true }) claimExpiresAt: Date | null;
  @Column({ name: "claim_fencing_token", type: "bigint", default: 0 }) claimFencingToken: string;
  @Column({ name: "published_job_id", nullable: true }) publishedJobId: string | null;
  @Column({ name: "last_error", type: "text", nullable: true }) lastError: string | null;
  @Column({ name: "published_at", type: "timestamptz", nullable: true }) publishedAt: Date | null;
  @CreateDateColumn({ name: "created_at", type: "timestamptz" }) createdAt: Date;
  @UpdateDateColumn({ name: "updated_at", type: "timestamptz" }) updatedAt: Date;
}
