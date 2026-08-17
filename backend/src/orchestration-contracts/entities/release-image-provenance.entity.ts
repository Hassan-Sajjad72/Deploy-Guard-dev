import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  Unique,
} from "typeorm";

/**
 * Immutable, credential-free evidence that an exact release image was pushed.
 * It deliberately exists before a ReleaseManifest is created for a first release.
 */
@Entity("release_image_provenances")
@Unique("UQ_release_image_provenance_operation", ["intentId", "operationId"])
@Unique("UQ_release_image_provenance_idempotency", ["intentId", "idempotencyKey"])
@Index("IDX_release_image_provenance_scope", ["projectId", "environmentName", "createdAt"])
@Check("CHK_release_image_provenance_digest", `"image_digest" ~ '^sha256:[0-9a-f]{64}$'`)
@Check("CHK_release_image_provenance_hashes", `"build_fingerprint" ~ '^[0-9a-f]{64}$' AND "evidence_fingerprint" ~ '^[0-9a-f]{64}$'`)
export class ReleaseImageProvenance {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Index("IDX_release_image_provenance_intent")
  @Column({ name: "intent_id", type: "uuid" })
  intentId: string;

  @Column({ name: "operation_id", type: "uuid" })
  operationId: string;

  @Column({ name: "idempotency_key", type: "char", length: 64 })
  idempotencyKey: string;

  @Column({ name: "project_id", type: "uuid" })
  projectId: string;

  @Column({ name: "environment_name", length: 64 })
  environmentName: string;

  @Column({ name: "infrastructure_manifest_id", type: "uuid" })
  infrastructureManifestId: string;

  @Column({ name: "infrastructure_revision", type: "bigint" })
  infrastructureRevision: string;

  @Column({ name: "commit_sha", length: 64 })
  commitSha: string;

  @Column({ name: "build_fingerprint", type: "char", length: 64 })
  buildFingerprint: string;

  @Column({ name: "image_uri" })
  imageUri: string;

  @Column({ name: "image_digest", length: 71 })
  imageDigest: string;

  @Column({ name: "evidence_fingerprint", type: "char", length: 64 })
  evidenceFingerprint: string;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt: Date;
}
