import { Column, Entity, JoinColumn, ManyToOne, PrimaryColumn } from "typeorm";
import { User } from "../users/user.entity";
import { Organization } from "./organization.entity";

export type OrganizationRole = "OWNER" | "ADMINISTRATOR" | "ENGINEER" | "APPROVER" | "VIEWER";

@Entity("organization_memberships")
export class OrganizationMembership {
  @PrimaryColumn({ name: "organization_id", type: "uuid" }) organizationId: string;
  @PrimaryColumn({ name: "user_id", type: "integer" }) userId: number;
  @Column({ type: "text" }) role: OrganizationRole;
  @Column({ name: "revoked_at", type: "timestamptz", nullable: true }) revokedAt: Date | null;
  @ManyToOne(() => Organization, { onDelete: "RESTRICT" })
  @JoinColumn({ name: "organization_id" }) organization: Organization;
  @ManyToOne(() => User, { onDelete: "RESTRICT" })
  @JoinColumn({ name: "user_id" }) user: User;
}
