import { Column, Entity, JoinColumn, ManyToOne, PrimaryColumn } from "typeorm";
import { User } from "../users/user.entity";
import { Organization } from "./organization.entity";

@Entity("organization_memberships")
export class OrganizationMembership {
  @PrimaryColumn({ name: "organization_id", type: "uuid" }) organizationId: string;
  @PrimaryColumn({ name: "user_id", type: "integer" }) userId: number;
  @Column() role: "owner" | "admin" | "engineer" | "approver" | "viewer";
  @ManyToOne(() => User, { onDelete: "CASCADE" })
  @JoinColumn({ name: "user_id" }) user: User;
  @ManyToOne(() => Organization, { onDelete: "RESTRICT" })
  @JoinColumn({ name: "organization_id" }) organization: Organization;
}
