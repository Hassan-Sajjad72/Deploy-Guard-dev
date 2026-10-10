import { Column, CreateDateColumn, Entity, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from "typeorm";
import { Organization } from "./organization.entity";

// PENDING is registration, not proof of account access or permission to mutate.
export type AwsAccountBindingStatus = "PENDING" | "REVOKED";

@Entity("aws_account_bindings")
export class AwsAccountBinding {
  @PrimaryGeneratedColumn("uuid") id: string;
  @Column({ name: "organization_id", type: "uuid" }) organizationId: string;
  @ManyToOne(() => Organization, { onDelete: "RESTRICT" })
  @JoinColumn({ name: "organization_id" }) organization: Organization;
  @Column({ name: "account_id", type: "varchar", length: 12 }) accountId: string;
  @Column({ type: "text" }) region: string;
  @Column({ name: "role_arn", type: "text" }) roleArn: string;
  @Column({ name: "external_id", type: "uuid" }) externalId: string;
  @Column({ type: "text", default: "PENDING" }) status: AwsAccountBindingStatus;
  @Column({ name: "revoked_at", type: "timestamptz", nullable: true }) revokedAt: Date | null;
  @CreateDateColumn({ name: "created_at", type: "timestamptz" }) createdAt: Date;
}
