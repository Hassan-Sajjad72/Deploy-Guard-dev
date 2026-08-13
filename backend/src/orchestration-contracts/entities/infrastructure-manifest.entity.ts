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
  InfrastructureChangeSetV1,
  InfrastructureManifestOrigin,
  InfrastructureManifestStatus,
  InfrastructureSpecV1,
} from "../contracts/infrastructure-manifest.types";

@Entity("infrastructure_manifests")
@Unique("UQ_infrastructure_manifest_revision", ["projectId", "environmentName", "revision"])
@Index("IDX_infrastructure_manifest_scope_status_created", ["projectId", "environmentName", "status", "createdAt"])
@Index("IDX_infrastructure_manifest_plan_fingerprints", ["planInputFingerprint", "planConfigurationFingerprint"])
@Index("UQ_infrastructure_manifest_current_applied", ["projectId", "environmentName"], { unique: true, where: `"status" = 'applied'` })
@Check("CHK_infrastructure_manifest_schema_version", `"schema_version" = 1`)
@Check("CHK_infrastructure_manifest_spec_hash", `"spec_hash" ~ '^[0-9a-f]{64}$'`)
@Check("CHK_infrastructure_manifest_origin", `"origin" IN ('planner','legacy_backfill','reconciliation_import')`)
@Check("CHK_infrastructure_manifest_status", `"status" IN ('desired','planning','planned','approval_required','approved','applying','applied','superseded','failed','destroying','destroyed','imported_unverified','manual_review')`)
@Check("CHK_infrastructure_manifest_state_backend", `"state_backend" IN ('s3','local_mock')`)
@Check("CHK_infrastructure_manifest_terraform_lifecycle", `"requires_terraform" = true OR "status" NOT IN ('planning','planned','approval_required','approved','applying')`)
export class InfrastructureManifest {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ name: "schema_version", type: "integer", default: 1 })
  schemaVersion: number;

  @Index("IDX_infrastructure_manifest_project")
  @Column({ name: "project_id", type: "uuid" })
  projectId: string;

  @Column({ name: "environment_name", length: 64 })
  environmentName: string;

  @Column({ type: "bigint" })
  revision: string;

  @Column({ name: "parent_manifest_id", type: "uuid", nullable: true })
  parentManifestId: string | null;

  @Column({ name: "created_by_intent_id", type: "uuid", nullable: true })
  createdByIntentId: string | null;

  @Column({ name: "created_by_user_id", type: "integer", nullable: true })
  createdByUserId: number | null;

  @Column({ type: "varchar", length: 32 })
  origin: InfrastructureManifestOrigin;

  @Index("IDX_infrastructure_manifest_status")
  @Column({ type: "varchar", length: 32, default: "desired" })
  status: InfrastructureManifestStatus;

  @Index("IDX_infrastructure_manifest_spec_hash")
  @Column({ name: "spec_hash", type: "char", length: 64 })
  specHash: string;

  @Column({ name: "terraform_template_version", length: 128 })
  terraformTemplateVersion: string;

  @Column({ name: "state_backend", type: "varchar", length: 16 })
  stateBackend: "s3" | "local_mock";

  @Column({ name: "state_key", length: 512 })
  stateKey: string;

  @Column({ name: "state_version_id", length: 512, nullable: true })
  stateVersionId: string | null;

  @Column({ name: "desired_spec", type: "jsonb" })
  desiredSpec: InfrastructureSpecV1;

  @Column({ name: "change_set", type: "jsonb", default: {} })
  changeSet: InfrastructureChangeSetV1;

  @Column({ name: "requires_terraform", default: true })
  requiresTerraform: boolean;

  @Column({ name: "plan_artifact_reference", type: "jsonb", nullable: true })
  planArtifactReference: Record<string, unknown> | null;

  @Column({ name: "plan_artifact_sha256", type: "char", length: 64, nullable: true })
  planArtifactSha256: string | null;

  @Column({ name: "plan_input_fingerprint", type: "char", length: 64, nullable: true })
  planInputFingerprint: string | null;

  @Column({ name: "plan_configuration_fingerprint", type: "char", length: 64, nullable: true })
  planConfigurationFingerprint: string | null;

  @Column({ name: "terraform_outputs", type: "jsonb", nullable: true })
  terraformOutputs: Record<string, unknown> | null;

  @Column({ name: "terraform_outputs_hash", type: "char", length: 64, nullable: true })
  terraformOutputsHash: string | null;

  @Column({ name: "resource_count", type: "integer", nullable: true })
  resourceCount: number | null;

  @Column({ name: "failure_code", length: 128, nullable: true })
  failureCode: string | null;

  @Column({ name: "failure_message", type: "text", nullable: true })
  failureMessage: string | null;

  @Column({ name: "planned_at", type: "timestamptz", nullable: true })
  plannedAt: Date | null;

  @Column({ name: "approved_at", type: "timestamptz", nullable: true })
  approvedAt: Date | null;

  @Column({ name: "apply_started_at", type: "timestamptz", nullable: true })
  applyStartedAt: Date | null;

  @Column({ name: "applied_at", type: "timestamptz", nullable: true })
  appliedAt: Date | null;

  @Column({ name: "superseded_at", type: "timestamptz", nullable: true })
  supersededAt: Date | null;

  @Column({ name: "destroyed_at", type: "timestamptz", nullable: true })
  destroyedAt: Date | null;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt: Date;

  @UpdateDateColumn({ name: "updated_at", type: "timestamptz" })
  updatedAt: Date;
}
