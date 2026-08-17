import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from "typeorm";

export type ReleaseLaneShadowDecision =
  | "acquirable"
  | "would_block_legacy"
  | "would_block_v1"
  | "unsafe_stale"
  | "insufficient_evidence";

@Entity("project_release_lane_shadow_observations")
@Unique("UQ_release_lane_shadow_operation", ["canonicalOperationKey"])
@Index("IDX_release_lane_shadow_scope", ["projectId", "environmentName", "insertionSource"])
@Check("CHK_release_lane_shadow_lane", `"proposed_lane" IN ('legacy','v1')`)
@Check("CHK_release_lane_shadow_decision", `"decision" IN ('acquirable','would_block_legacy','would_block_v1','unsafe_stale','insufficient_evidence')`)
@Check("CHK_release_lane_shadow_hashes", `"canonical_operation_key" ~ '^[0-9a-f]{64}$' AND "evidence_hash" ~ '^[0-9a-f]{64}$'`)
export class ProjectReleaseLaneShadowObservation {
  @PrimaryGeneratedColumn("uuid") id: string;

  @Column({ name: "project_id", type: "uuid" }) projectId: string;
  @Column({ name: "environment_name", length: 64 }) environmentName: string;
  @Column({ name: "proposed_lane", type: "varchar", length: 16 }) proposedLane: "legacy" | "v1";
  @Column({ name: "operation_class", length: 64 }) operationClass: string;
  @Column({ name: "insertion_source", length: 128 }) insertionSource: string;
  @Column({ name: "canonical_operation_key", type: "char", length: 64 }) canonicalOperationKey: string;
  @Column({ type: "varchar", length: 32 }) decision: ReleaseLaneShadowDecision;
  @Column({ name: "current_owner_lane", type: "varchar", length: 16, nullable: true }) currentOwnerLane: "legacy" | "v1" | null;
  @Column({ name: "current_fencing_token", type: "bigint", nullable: true }) currentFencingToken: string | null;
  @Column({ name: "evidence_hash", type: "char", length: 64 }) evidenceHash: string;
  @Column({ name: "observed_at", type: "timestamptz", default: () => "now()" }) observedAt: Date;
  @CreateDateColumn({ name: "created_at", type: "timestamptz" }) createdAt: Date;
  @UpdateDateColumn({ name: "updated_at", type: "timestamptz" }) updatedAt: Date;
}
