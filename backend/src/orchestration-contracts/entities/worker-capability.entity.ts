import { Check, Column, CreateDateColumn, Entity, Index, PrimaryColumn, UpdateDateColumn } from "typeorm";
import { WorkerMessageType } from "../contracts/worker-envelope.types";

export type WorkerRole = "legacy_pipeline" | "release" | "infrastructure" | "deletion" | "outbox_dispatcher";

@Entity("worker_capabilities")
@Index("IDX_worker_capability_protocol", ["role", "minimumProtocol", "maximumProtocol"])
@Check("CHK_worker_capability_role", `"role" IN ('legacy_pipeline','release','infrastructure','deletion','outbox_dispatcher')`)
@Check("CHK_worker_capability_protocol_range", `"minimum_protocol" > 0 AND "maximum_protocol" >= "minimum_protocol"`)
@Check("CHK_worker_capability_message_types", `jsonb_typeof("supported_message_types") = 'array'`)
export class WorkerCapability {
  @PrimaryColumn({ name: "worker_id" }) workerId: string;
  @Index("IDX_worker_capability_role") @Column({ type: "varchar", length: 32 }) role: WorkerRole;
  @Column({ name: "minimum_protocol", type: "integer" }) minimumProtocol: number;
  @Column({ name: "maximum_protocol", type: "integer" }) maximumProtocol: number;
  @Column({ name: "supported_message_types", type: "jsonb", default: [] }) supportedMessageTypes: WorkerMessageType[];
  @Column({ name: "service_version" }) serviceVersion: string;
  @Column({ name: "git_sha" }) gitSha: string;
  @Column({ name: "started_at", type: "timestamptz", default: () => "now()" }) startedAt: Date;
  @Column({ name: "heartbeat_at", type: "timestamptz", default: () => "now()" }) heartbeatAt: Date;
  @Index("IDX_worker_capability_expires_at") @Column({ name: "expires_at", type: "timestamptz" }) expiresAt: Date;
  @Column({ type: "jsonb", default: {} }) metadata: Record<string, unknown>;
  @CreateDateColumn({ name: "created_at", type: "timestamptz" }) createdAt: Date;
  @UpdateDateColumn({ name: "updated_at", type: "timestamptz" }) updatedAt: Date;
}
