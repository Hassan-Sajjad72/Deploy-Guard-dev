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
  ReleaseManifestOrigin,
  ReleaseManifestStatus,
  ReleaseSpecV1,
} from "../contracts/release-manifest.types";

@Entity("release_manifests")
@Unique("UQ_release_manifest_revision", ["projectId", "environmentName", "revision"])
@Index("IDX_release_manifest_scope_status_created", ["projectId", "environmentName", "status", "createdAt"])
@Index("IDX_release_manifest_fingerprints", ["buildFingerprint", "runtimeFingerprint", "configurationFingerprint"])
@Index("UQ_release_manifest_current_stable", ["projectId", "environmentName"], { unique: true, where: `"status" = 'stable'` })
@Check("CHK_release_manifest_schema_version", `"schema_version" = 1`)
@Check("CHK_release_manifest_spec_hash", `"spec_hash" ~ '^[0-9a-f]{64}$'`)
@Check("CHK_release_manifest_origin", `"origin" IN ('planner','legacy_backfill','rollback')`)
@Check("CHK_release_manifest_status", `"status" IN ('desired','blocked_on_infrastructure','building','built','deploying','waiting_for_stability','health_checking','healthy','stable','failed','rollback_started','rolled_back','superseded','cancelled','imported_unverified','manual_review')`)
@Check("CHK_release_manifest_stable_evidence", `"status" <> 'stable' OR ("image_digest" IS NOT NULL AND "task_definition_arn" IS NOT NULL AND "health_verified_at" IS NOT NULL AND "promoted_at" IS NOT NULL)`)
@Check(
  "CHK_release_manifest_initial_service_hash",
  `"initial_service_input_hash" IS NULL OR "initial_service_input_hash" ~ '^[0-9a-f]{64}$'`,
)
export class ReleaseManifest {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ name: "schema_version", type: "integer", default: 1 })
  schemaVersion: number;

  @Index("IDX_release_manifest_project")
  @Column({ name: "project_id", type: "uuid" })
  projectId: string;

  @Column({ name: "environment_name", length: 64 })
  environmentName: string;

  @Column({ type: "bigint" })
  revision: string;

  @Column({ name: "parent_manifest_id", type: "uuid", nullable: true })
  parentManifestId: string | null;

  @Column({ name: "previous_stable_manifest_id", type: "uuid", nullable: true })
  previousStableManifestId: string | null;

  @Index("IDX_release_manifest_infrastructure")
  @Column({ name: "infrastructure_manifest_id", type: "uuid" })
  infrastructureManifestId: string;

  @Column({ name: "created_by_intent_id", type: "uuid", nullable: true })
  createdByIntentId: string | null;

  @Column({ name: "pipeline_run_id", type: "uuid", nullable: true })
  pipelineRunId: string | null;

  @Column({ name: "deployment_contract_id", type: "uuid", nullable: true })
  deploymentContractId: string | null;

  @Column({ name: "configuration_snapshot_id", type: "uuid", nullable: true })
  configurationSnapshotId: string | null;

  @Column({ type: "varchar", length: 32 })
  origin: ReleaseManifestOrigin;

  @Index("IDX_release_manifest_status")
  @Column({ type: "varchar", length: 32, default: "desired" })
  status: ReleaseManifestStatus;

  @Index("IDX_release_manifest_spec_hash")
  @Column({ name: "spec_hash", type: "char", length: 64 })
  specHash: string;

  @Column({ name: "repository_full_name" })
  repositoryFullName: string;

  @Column()
  branch: string;

  @Column({ name: "commit_sha" })
  commitSha: string;

  @Column({ name: "app_root", default: "." })
  appRoot: string;

  @Column({ name: "deployment_contract_hash", type: "char", length: 64 })
  deploymentContractHash: string;

  @Column({ name: "configuration_fingerprint", type: "char", length: 64 })
  configurationFingerprint: string;

  @Column({ name: "build_fingerprint", type: "char", length: 64 })
  buildFingerprint: string;

  @Column({ name: "runtime_fingerprint", type: "char", length: 64 })
  runtimeFingerprint: string;

  @Column({ name: "image_uri", nullable: true })
  imageUri: string | null;

  @Column({ name: "image_digest", nullable: true })
  imageDigest: string | null;

  @Column({ name: "task_definition_input_hash", type: "char", length: 64, nullable: true })
  taskDefinitionInputHash: string | null;

  @Column({ name: "task_definition_arn", nullable: true })
  taskDefinitionArn: string | null;

  @Column({ name: "initial_service_input_hash", type: "char", length: 64, nullable: true })
  initialServiceInputHash: string | null;

  @Column({ name: "initial_service_arn", nullable: true })
  initialServiceArn: string | null;

  @Column({ name: "release_spec", type: "jsonb" })
  releaseSpec: ReleaseSpecV1;

  @Column({ name: "health_evidence", type: "jsonb", nullable: true })
  healthEvidence: Record<string, unknown> | null;

  @Column({ name: "failure_code", length: 128, nullable: true })
  failureCode: string | null;

  @Column({ name: "failure_message", type: "text", nullable: true })
  failureMessage: string | null;

  @Column({ name: "build_started_at", type: "timestamptz", nullable: true })
  buildStartedAt: Date | null;

  @Column({ name: "built_at", type: "timestamptz", nullable: true })
  builtAt: Date | null;

  @Column({ name: "deployment_started_at", type: "timestamptz", nullable: true })
  deploymentStartedAt: Date | null;

  @Column({ name: "health_verified_at", type: "timestamptz", nullable: true })
  healthVerifiedAt: Date | null;

  @Column({ name: "promoted_at", type: "timestamptz", nullable: true })
  promotedAt: Date | null;

  @Column({ name: "superseded_at", type: "timestamptz", nullable: true })
  supersededAt: Date | null;

  @Column({ name: "rollback_started_at", type: "timestamptz", nullable: true })
  rollbackStartedAt: Date | null;

  @Column({ name: "rolled_back_at", type: "timestamptz", nullable: true })
  rolledBackAt: Date | null;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt: Date;

  @UpdateDateColumn({ name: "updated_at", type: "timestamptz" })
  updatedAt: Date;
}
