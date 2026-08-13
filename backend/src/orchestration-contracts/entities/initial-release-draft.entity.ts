import { Check, Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, Unique } from "typeorm";
import { CreateReleaseManifestInputV1 } from "../contracts/release-manifest.types";

/** Immutable pre-image release draft for the one-shot initial-release path. */
@Entity("initial_release_drafts")
@Unique("UQ_initial_release_draft_intent", ["intentId"])
@Index("IDX_initial_release_draft_scope", ["projectId", "environmentName", "createdAt"])
@Check("CHK_initial_release_draft_hash", `"draft_hash" ~ '^[0-9a-f]{64}$'`)
export class InitialReleaseDraft {
  @PrimaryGeneratedColumn("uuid") id: string;
  @Column({ name: "intent_id", type: "uuid" }) intentId: string;
  @Column({ name: "project_id", type: "uuid" }) projectId: string;
  @Column({ name: "environment_name", length: 64 }) environmentName: string;
  @Column({ name: "infrastructure_manifest_id", type: "uuid" }) infrastructureManifestId: string;
  @Column({ name: "infrastructure_revision", type: "bigint" }) infrastructureRevision: string;
  @Column({ name: "draft_hash", type: "char", length: 64 }) draftHash: string;
  @Column({ name: "release_draft", type: "jsonb" }) releaseDraft: CreateReleaseManifestInputV1;
  @CreateDateColumn({ name: "created_at", type: "timestamptz" }) createdAt: Date;
}
