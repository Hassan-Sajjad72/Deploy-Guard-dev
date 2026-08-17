import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from "typeorm";

export type ReleaseLaneOwner = "legacy" | "v1";
export type ReleaseLaneOwnershipStatus =
  | "acquired"
  | "heartbeat_active"
  | "released"
  | "expired";

/**
 * A single, deliberately separate cross-lane fence. It is not an execution
 * operation lease and is not wired into either execution lane yet.
 */
@Entity("project_release_lane_ownerships")
@Index("UQ_release_lane_ownership_scope", ["projectId", "environmentName"], {
  unique: true,
})
@Index(
  "UQ_release_lane_ownership_fencing_token",
  ["projectId", "environmentName", "fencingToken"],
  { unique: true },
)
@Check("CHK_release_lane_ownership_lane", `"owner_lane" IN ('legacy','v1')`)
@Check(
  "CHK_release_lane_ownership_status",
  `"status" IN ('acquired','heartbeat_active','released','expired')`,
)
@Check("CHK_release_lane_ownership_fencing_token", `"fencing_token" > 0`)
@Check(
  "CHK_release_lane_ownership_hashes",
  `"idempotency_key" ~ '^[0-9a-f]{64}$' AND "request_fingerprint" ~ '^[0-9a-f]{64}$'`,
)
export class ProjectReleaseLaneOwnership {
  @PrimaryGeneratedColumn("uuid") id: string;

  @Index("IDX_release_lane_ownership_project")
  @Column({ name: "project_id", type: "uuid" }) projectId: string;

  @Column({ name: "environment_name", length: 64 }) environmentName: string;
  @Column({ name: "owner_lane", type: "varchar", length: 16 }) ownerLane: ReleaseLaneOwner;
  @Column({ name: "lease_id", type: "uuid" }) leaseId: string;
  @Column({ name: "actor_id", length: 160 }) actorId: string;
  @Column({ name: "idempotency_key", type: "char", length: 64 }) idempotencyKey: string;
  @Column({ name: "request_fingerprint", type: "char", length: 64 }) requestFingerprint: string;
  @Column({ name: "fencing_token", type: "bigint" }) fencingToken: string;
  /**
   * Optional v1 correlations. These are intentionally distinct from this
   * ownership lease and are populated only by the inactive correlation adapter.
   */
  @Index("IDX_release_lane_ownership_deployment_intent", {
    where: `"deployment_intent_id" IS NOT NULL`,
  })
  @Column({ name: "deployment_intent_id", type: "uuid", nullable: true })
  deploymentIntentId: string | null;

  @Index("IDX_release_lane_ownership_operation_lease", {
    where: `"operation_lease_id" IS NOT NULL`,
  })
  @Column({ name: "operation_lease_id", type: "uuid", nullable: true })
  operationLeaseId: string | null;

  @Column({ type: "varchar", length: 24, default: "acquired" }) status: ReleaseLaneOwnershipStatus;
  @Column({ name: "acquired_at", type: "timestamptz", default: () => "now()" }) acquiredAt: Date;
  @Column({ name: "heartbeat_at", type: "timestamptz", default: () => "now()" }) heartbeatAt: Date;
  @Column({ name: "expires_at", type: "timestamptz" }) expiresAt: Date;
  @Column({ name: "released_at", type: "timestamptz", nullable: true }) releasedAt: Date | null;
  @CreateDateColumn({ name: "created_at", type: "timestamptz" }) createdAt: Date;
  @UpdateDateColumn({ name: "updated_at", type: "timestamptz" }) updatedAt: Date;
}
