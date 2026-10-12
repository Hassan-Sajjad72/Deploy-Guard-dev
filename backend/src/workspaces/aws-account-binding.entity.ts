import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from "typeorm";

@Entity("aws_account_bindings")
@Index(["organizationId", "accountId", "roleArn"], { unique: true })
export class AwsAccountBinding {
  @PrimaryGeneratedColumn("uuid") id: string;
  @Column({ name: "organization_id", type: "uuid" }) organizationId: string;
  @Column({ name: "account_id", length: 12 }) accountId: string;
  @Column({ name: "role_arn" }) roleArn: string;
  @Column({ name: "external_id", select: false }) externalId: string;
  @Column({ type: "jsonb" }) regions: string[];
  @Column({ name: "verification_status", default: "pending" }) verificationStatus: "pending" | "verified" | "failed" | "revoked";
  @Column({ name: "verification_version", default: 0 }) verificationVersion: number;
  @Column({ name: "verified_at", type: "timestamptz", nullable: true }) verifiedAt: Date | null;
  @Column({ name: "verification_evidence", type: "jsonb", nullable: true }) verificationEvidence: Record<string, unknown> | null;
  @CreateDateColumn({ name: "created_at", type: "timestamptz" }) createdAt: Date;
}
