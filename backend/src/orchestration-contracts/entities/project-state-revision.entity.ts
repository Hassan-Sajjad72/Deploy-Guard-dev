import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, Unique, UpdateDateColumn } from "typeorm";

@Entity("project_state_revisions")
@Unique("UQ_project_state_revision_scope", ["projectId", "environmentName"])
export class ProjectStateRevision {
  @PrimaryGeneratedColumn("uuid") id: string;
  @Index("IDX_project_state_revision_project") @Column({ name: "project_id", type: "uuid" }) projectId: string;
  @Column({ name: "environment_name", length: 64 }) environmentName: string;
  @Column({ type: "bigint", default: 0 }) revision: string;
  @Column({ name: "invalidated_at", type: "timestamptz", default: () => "now()" }) invalidatedAt: Date;
  @Column({ length: 255 }) reason: string;
  @Column({ name: "source_type", length: 64 }) sourceType: string;
  @Column({ name: "source_id", nullable: true }) sourceId: string | null;
  @CreateDateColumn({ name: "created_at", type: "timestamptz" }) createdAt: Date;
  @UpdateDateColumn({ name: "updated_at", type: "timestamptz" }) updatedAt: Date;
}
