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
import { ProjectOperationLease } from "./project-operation-lease.entity";

export type DeploymentSideEffectStatus =
  | "prepared"
  | "started"
  | "succeeded"
  | "failed"
  | "uncertain"
  | "reconciled";

@Entity("deployment_side_effects")
@ForeignKey(() => DeploymentIntent, ["intentId"], ["id"], {
  name: "FK_deployment_side_effect_intent",
  onDelete: "RESTRICT",
})
@ForeignKey(() => ProjectOperationLease, ["leaseId"], ["id"], {
  name: "FK_deployment_side_effect_lease",
  onDelete: "RESTRICT",
})
@ForeignKey(() => Project, ["projectId"], ["id"], {
  name: "FK_deployment_side_effect_project",
  onDelete: "RESTRICT",
})
@Index("UQ_deployment_side_effect_operation", ["intentId", "operationId"], {
  unique: true,
})
@Index("UQ_deployment_side_effect_idempotency", [
  "intentId",
  "idempotencyKey",
], {
  unique: true,
})
@Index("IDX_deployment_side_effect_reconciliation", [
  "reconciliationRequired",
  "status",
  "updatedAt",
])
@Check(
  "CHK_deployment_side_effect_status",
  `"status" IN ('prepared','started','succeeded','failed','uncertain','reconciled')`,
)
@Check(
  "CHK_deployment_side_effect_hashes",
  `"request_fingerprint" ~ '^[0-9a-f]{64}$'`
    + ` AND ("result_fingerprint" IS NULL`
    + ` OR "result_fingerprint" ~ '^[0-9a-f]{64}$')`
    + ` AND ("external_reference_hash" IS NULL`
    + ` OR "external_reference_hash" ~ '^[0-9a-f]{64}$')`,
)
@Check(
  "CHK_deployment_side_effect_fencing",
  `"fencing_token" > 0`,
)
export class DeploymentSideEffect {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Index("IDX_deployment_side_effect_intent")
  @Column({ name: "intent_id", type: "uuid" })
  intentId: string;

  @Index("IDX_deployment_side_effect_project")
  @Column({ name: "project_id", type: "uuid" })
  projectId: string;

  @Column({ name: "environment_name", length: 64 })
  environmentName: string;

  @Column({ name: "operation_id", type: "uuid" })
  operationId: string;

  @Column({ name: "effect_type", length: 96 })
  effectType: string;

  @Column({ name: "idempotency_key", type: "char", length: 64 })
  idempotencyKey: string;

  @Column({ name: "request_fingerprint", type: "char", length: 64 })
  requestFingerprint: string;

  @Column({ name: "lease_id", type: "uuid" })
  leaseId: string;

  @Column({ name: "owner_worker_id" })
  ownerWorkerId: string;

  @Column({ name: "fencing_token", type: "bigint" })
  fencingToken: string;

  @Column({ type: "varchar", length: 24 })
  status: DeploymentSideEffectStatus;

  @Column({ name: "safe_result_code", length: 128, nullable: true })
  safeResultCode: string | null;

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
    name: "reconciliation_required",
    default: false,
  })
  reconciliationRequired: boolean;

  @Column({ name: "attempt_started_at", type: "timestamptz", nullable: true })
  attemptStartedAt: Date | null;

  @Column({ name: "deadline_at", type: "timestamptz", nullable: true })
  deadlineAt: Date | null;

  @Column({ name: "completed_at", type: "timestamptz", nullable: true })
  completedAt: Date | null;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt: Date;

  @UpdateDateColumn({ name: "updated_at", type: "timestamptz" })
  updatedAt: Date;
}
