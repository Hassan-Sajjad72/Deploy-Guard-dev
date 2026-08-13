import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  ForeignKey,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from "typeorm";
import { Project } from "../../projects/project.entity";
import { DeploymentIntent } from "./deployment-intent.entity";
import { DeploymentSideEffect } from "./deployment-side-effect.entity";

export type SideEffectReconciliationLeaseStatus =
  | "acquired"
  | "heartbeat_active"
  | "released"
  | "expired"
  | "failed";

@Entity("deployment_side_effect_reconciliation_leases")
@ForeignKey(() => DeploymentSideEffect, ["sideEffectId"], ["id"], {
  name: "FK_side_effect_reconciliation_lease_effect",
  onDelete: "RESTRICT",
})
@ForeignKey(() => DeploymentIntent, ["intentId"], ["id"], {
  name: "FK_side_effect_reconciliation_lease_intent",
  onDelete: "RESTRICT",
})
@ForeignKey(() => Project, ["projectId"], ["id"], {
  name: "FK_side_effect_reconciliation_lease_project",
  onDelete: "RESTRICT",
})
@Index(
  "UQ_side_effect_reconciliation_lease_active",
  ["sideEffectId"],
  {
    unique: true,
    where: `"status" IN ('acquired','heartbeat_active')`,
  },
)
@Index(
  "UQ_side_effect_reconciliation_lease_fencing",
  ["sideEffectId", "fencingToken"],
  { unique: true },
)
@Check(
  "CHK_side_effect_reconciliation_lease_status",
  `"status" IN (`
    + `'acquired','heartbeat_active','released','expired','failed')`,
)
@Check(
  "CHK_side_effect_reconciliation_lease_fencing",
  `"fencing_token" > 0`,
)
@Check(
  "CHK_side_effect_reconciliation_lease_origin",
  `"origin" IN ('coordinator','legacy_backfill')`,
)
export class DeploymentSideEffectReconciliationLease {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Index("IDX_side_effect_reconciliation_lease_effect")
  @Column({ name: "side_effect_id", type: "uuid" })
  sideEffectId: string;

  @Column({ name: "intent_id", type: "uuid" })
  intentId: string;

  @Column({ name: "project_id", type: "uuid" })
  projectId: string;

  @Column({ name: "environment_name", length: 64 })
  environmentName: string;

  @Column({ name: "owner_worker_id" })
  ownerWorkerId: string;

  @Column({ name: "fencing_token", type: "bigint" })
  fencingToken: string;

  @Index("IDX_side_effect_reconciliation_lease_status")
  @Column({ type: "varchar", length: 24 })
  status: SideEffectReconciliationLeaseStatus;

  @Column({ type: "varchar", length: 24, default: "coordinator" })
  origin: "coordinator" | "legacy_backfill";

  @Column({
    name: "legacy_operation_lease_id",
    type: "uuid",
    nullable: true,
  })
  legacyOperationLeaseId: string | null;

  @Column({
    name: "acquired_at",
    type: "timestamptz",
    default: () => "now()",
  })
  acquiredAt: Date;

  @Column({
    name: "heartbeat_at",
    type: "timestamptz",
    default: () => "now()",
  })
  heartbeatAt: Date;

  @Column({ name: "expires_at", type: "timestamptz" })
  expiresAt: Date;

  @Column({ name: "released_at", type: "timestamptz", nullable: true })
  releasedAt: Date | null;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt: Date;

  @UpdateDateColumn({ name: "updated_at", type: "timestamptz" })
  updatedAt: Date;
}
