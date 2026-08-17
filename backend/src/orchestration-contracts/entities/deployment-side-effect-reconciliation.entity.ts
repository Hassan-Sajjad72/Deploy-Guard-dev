import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  ForeignKey,
  Index,
  PrimaryGeneratedColumn,
} from "typeorm";
import { Project } from "../../projects/project.entity";
import { DeploymentIntent } from "./deployment-intent.entity";
import { DeploymentSideEffectReconciliationLease } from "./deployment-side-effect-reconciliation-lease.entity";
import { DeploymentSideEffect } from "./deployment-side-effect.entity";

export type DeploymentSideEffectReconciliationClassification =
  | "succeeded"
  | "failed"
  | "pending"
  | "manual_review";

@Entity("deployment_side_effect_reconciliations")
@ForeignKey(() => DeploymentSideEffect, ["sideEffectId"], ["id"], {
  name: "FK_side_effect_reconciliation_effect",
  onDelete: "RESTRICT",
})
@ForeignKey(() => DeploymentIntent, ["intentId"], ["id"], {
  name: "FK_side_effect_reconciliation_intent",
  onDelete: "RESTRICT",
})
@ForeignKey(
  () => DeploymentSideEffectReconciliationLease,
  ["leaseId"],
  ["id"],
  {
    name: "FK_side_effect_reconciliation_lease",
    onDelete: "RESTRICT",
  },
)
@ForeignKey(() => Project, ["projectId"], ["id"], {
  name: "FK_side_effect_reconciliation_project",
  onDelete: "RESTRICT",
})
@Index("UQ_side_effect_reconciliation_operation", [
  "sideEffectId",
  "operationId",
], {
  unique: true,
})
@Index("UQ_side_effect_reconciliation_idempotency", [
  "sideEffectId",
  "idempotencyKey",
], {
  unique: true,
})
@Index("IDX_side_effect_reconciliation_effect", ["sideEffectId", "createdAt"])
@Index("IDX_side_effect_reconciliation_incomplete", ["createdAt"], {
  where: `"classification" IS NULL`,
})
@Check(
  "CHK_side_effect_reconciliation_classification",
  `"classification" IS NULL OR "classification" IN (`
    + `'succeeded','failed','pending','manual_review')`,
)
@Check(
  "CHK_side_effect_reconciliation_hashes",
  `"request_fingerprint" ~ '^[0-9a-f]{64}$'`
    + ` AND ("evidence_fingerprint" IS NULL`
    + ` OR "evidence_fingerprint" ~ '^[0-9a-f]{64}$')`
    + ` AND ("result_fingerprint" IS NULL`
    + ` OR "result_fingerprint" ~ '^[0-9a-f]{64}$')`
    + ` AND ("external_reference_hash" IS NULL`
    + ` OR "external_reference_hash" ~ '^[0-9a-f]{64}$')`,
)
@Check(
  "CHK_side_effect_reconciliation_fencing",
  `"fencing_token" > 0`,
)
export class DeploymentSideEffectReconciliation {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ name: "side_effect_id", type: "uuid" })
  sideEffectId: string;

  @Column({ name: "intent_id", type: "uuid" })
  intentId: string;

  @Column({ name: "project_id", type: "uuid" })
  projectId: string;

  @Column({ name: "environment_name", length: 64 })
  environmentName: string;

  @Column({ name: "operation_id", type: "uuid" })
  operationId: string;

  @Column({ name: "idempotency_key", type: "char", length: 64 })
  idempotencyKey: string;

  @Column({ name: "adapter_id", length: 96 })
  adapterId: string;

  @Column({ name: "request_fingerprint", type: "char", length: 64 })
  requestFingerprint: string;

  @Column({ name: "lease_id", type: "uuid" })
  leaseId: string;

  @Column({ name: "owner_worker_id" })
  ownerWorkerId: string;

  @Column({ name: "fencing_token", type: "bigint" })
  fencingToken: string;

  @Column({ type: "varchar", length: 24, nullable: true })
  classification: DeploymentSideEffectReconciliationClassification | null;

  @Column({ name: "safe_evidence_code", length: 128, nullable: true })
  safeEvidenceCode: string | null;

  @Column({
    name: "evidence_fingerprint",
    type: "char",
    length: 64,
    nullable: true,
  })
  evidenceFingerprint: string | null;

  @Column({
    name: "result_fingerprint",
    type: "char",
    length: 64,
    nullable: true,
  })
  resultFingerprint: string | null;

  @Column({
    name: "external_reference_hash",
    type: "char",
    length: 64,
    nullable: true,
  })
  externalReferenceHash: string | null;

  @Column({ name: "failure_code", length: 128, nullable: true })
  failureCode: string | null;

  @Column({
    name: "inspection_started_at",
    type: "timestamptz",
    default: () => "now()",
  })
  inspectionStartedAt: Date;

  @Column({ name: "completed_at", type: "timestamptz", nullable: true })
  completedAt: Date | null;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt: Date;
}
