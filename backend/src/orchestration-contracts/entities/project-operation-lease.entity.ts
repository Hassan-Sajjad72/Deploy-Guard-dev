import { Check, Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from "typeorm";
import { ExecutionLane } from "../contracts/deployment-intent.types";

export type OperationLeaseStatus = "acquired" | "heartbeat_active" | "released" | "expired" | "failed";

@Entity("project_operation_leases")
@Index("UQ_project_operation_lease_active_scope", ["projectId", "environmentName", "lane", "scope"], { unique: true, where: `"status" IN ('acquired','heartbeat_active')` })
@Index("UQ_project_operation_lease_fencing_token", ["projectId", "environmentName", "fencingToken"], { unique: true })
@Check("CHK_project_operation_lease_lane", `"lane" IN ('release','infrastructure','deletion')`)
@Check("CHK_project_operation_lease_scope", `"scope" IN ('execute','plan','apply','promote','destroy')`)
@Check("CHK_project_operation_lease_status", `"status" IN ('acquired','heartbeat_active','released','expired','failed')`)
@Check("CHK_project_operation_lease_fencing_token", `"fencing_token" > 0`)
export class ProjectOperationLease {
  @PrimaryGeneratedColumn("uuid") id: string;
  @Index("IDX_project_operation_lease_project") @Column({ name: "project_id", type: "uuid" }) projectId: string;
  @Column({ name: "environment_name", length: 64 }) environmentName: string;
  @Column({ type: "varchar", length: 24 }) lane: ExecutionLane;
  @Column({ type: "varchar", length: 32 }) scope: "execute" | "plan" | "apply" | "promote" | "destroy";
  @Index("IDX_project_operation_lease_intent") @Column({ name: "intent_id", type: "uuid" }) intentId: string;
  @Column({ name: "pipeline_run_id", type: "uuid", nullable: true }) pipelineRunId: string | null;
  @Column({ name: "destroy_operation_id", type: "uuid", nullable: true }) destroyOperationId: string | null;
  @Column({ name: "owner_worker_id" }) ownerWorkerId: string;
  @Column({ name: "fencing_token", type: "bigint" }) fencingToken: string;
  @Index("IDX_project_operation_lease_status") @Column({ type: "varchar", length: 24, default: "acquired" }) status: OperationLeaseStatus;
  @Column({ name: "acquired_at", type: "timestamptz", default: () => "now()" }) acquiredAt: Date;
  @Column({ name: "heartbeat_at", type: "timestamptz", default: () => "now()" }) heartbeatAt: Date;
  @Column({ name: "expires_at", type: "timestamptz" }) expiresAt: Date;
  @Column({ name: "released_at", type: "timestamptz", nullable: true }) releasedAt: Date | null;
  @Column({ type: "jsonb", default: {} }) metadata: Record<string, unknown>;
  @CreateDateColumn({ name: "created_at", type: "timestamptz" }) createdAt: Date;
  @UpdateDateColumn({ name: "updated_at", type: "timestamptz" }) updatedAt: Date;
}
