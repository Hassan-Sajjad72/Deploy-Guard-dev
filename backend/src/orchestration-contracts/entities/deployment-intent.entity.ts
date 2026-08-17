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
import {
  DeploymentClassification,
  DeploymentIntentKind,
  DeploymentIntentStatus,
} from "../contracts/deployment-intent.types";

@Entity("deployment_intents")
@Unique(
  "UQ_deployment_intent_idempotency",
  ["projectId", "environmentName", "canonicalIdempotencyKey"],
)
@Check("CHK_deployment_intent_schema_version", `"schema_version" = 1`)
@Check("CHK_deployment_intent_kind", `"kind" IN ('deploy','retry','resume','plan','apply','rollback','destroy','cleanup','legacy_import')`)
@Check("CHK_deployment_intent_classification", `"classification" IS NULL OR "classification" IN ('release_only','infrastructure_change','no_op','unsafe_or_unknown','deletion')`)
@Check("CHK_deployment_intent_status", `"status" IN ('received','planned','enqueued','running','plan_completed','completed','failed','cancelled','no_op','rejected')`)
@Check("CHK_deployment_intent_hashes", `"canonical_idempotency_key" ~ '^[0-9a-f]{64}$' AND "request_fingerprint" ~ '^[0-9a-f]{64}$'`)
export class DeploymentIntent {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ name: "schema_version", type: "integer", default: 1 })
  schemaVersion: number;

  @Index("IDX_deployment_intent_project")
  @Column({ name: "project_id", type: "uuid" })
  projectId: string;

  @Column({ name: "environment_name", length: 64 })
  environmentName: string;

  @Column({ name: "requested_by_user_id", type: "integer", nullable: true })
  requestedByUserId: number | null;

  @Column({ type: "varchar", length: 32 })
  kind: DeploymentIntentKind;

  @Column({ type: "varchar", length: 32, nullable: true })
  classification: DeploymentClassification | null;

  @Index("IDX_deployment_intent_status")
  @Column({ type: "varchar", length: 32, default: "received" })
  status: DeploymentIntentStatus;

  @Column({ name: "client_idempotency_key", length: 255 })
  clientIdempotencyKey: string;

  @Column({ name: "canonical_idempotency_key", type: "char", length: 64 })
  canonicalIdempotencyKey: string;

  @Index("IDX_deployment_intent_request_fingerprint")
  @Column({ name: "request_fingerprint", type: "char", length: 64 })
  requestFingerprint: string;

  @Column({ name: "request_payload", type: "jsonb", default: {} })
  requestPayload: Record<string, unknown>;

  @Column({ type: "jsonb", nullable: true })
  decision: Record<string, unknown> | null;

  @Column({ name: "infrastructure_manifest_id", type: "uuid", nullable: true })
  infrastructureManifestId: string | null;

  @Column({ name: "release_manifest_id", type: "uuid", nullable: true })
  releaseManifestId: string | null;

  @Column({ name: "source_pipeline_run_id", type: "uuid", nullable: true })
  sourcePipelineRunId: string | null;

  @Column({ name: "pipeline_run_id", type: "uuid", nullable: true })
  pipelineRunId: string | null;

  @Column({ name: "destroy_operation_id", type: "uuid", nullable: true })
  destroyOperationId: string | null;

  @Column({ name: "failure_code", length: 128, nullable: true })
  failureCode: string | null;

  @Column({ name: "failure_message", type: "text", nullable: true })
  failureMessage: string | null;

  @Column({ name: "received_at", type: "timestamptz", default: () => "now()" })
  receivedAt: Date;

  @Column({ name: "planned_at", type: "timestamptz", nullable: true })
  plannedAt: Date | null;

  @Column({ name: "enqueued_at", type: "timestamptz", nullable: true })
  enqueuedAt: Date | null;

  @Column({ name: "started_at", type: "timestamptz", nullable: true })
  startedAt: Date | null;

  @Column({ name: "completed_at", type: "timestamptz", nullable: true })
  completedAt: Date | null;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt: Date;

  @UpdateDateColumn({ name: "updated_at", type: "timestamptz" })
  updatedAt: Date;
}
