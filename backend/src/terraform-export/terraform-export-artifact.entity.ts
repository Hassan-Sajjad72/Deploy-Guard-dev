import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from "typeorm";
@Entity("terraform_export_artifacts")
export class TerraformExportArtifact {
  @PrimaryGeneratedColumn("uuid") id: string;
  @Index() @Column({ name: "project_id", type: "uuid" }) projectId: string;
  @Index() @Column({ name: "user_id" }) userId: number;
  @Column() filename: string;
  @Column() checksum: string;
  @Column({ name: "size_bytes" }) sizeBytes: number;
  @Column({ type: "bytea", select: false }) archive: Buffer;
  @Column({ name: "manifest", type: "jsonb" }) manifest: Record<string, unknown>;
  @Column({ name: "expires_at", type: "timestamptz" }) expiresAt: Date;
  @CreateDateColumn({ name: "created_at", type: "timestamptz" }) createdAt: Date;
}
