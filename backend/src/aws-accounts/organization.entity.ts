import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from "typeorm";

export type OrganizationMode = "TEAM" | "AGENCY";

@Entity("organizations")
export class Organization {
  @PrimaryGeneratedColumn("uuid") id: string;
  @Column({ length: 120 }) name: string;
  @Column({ type: "text", default: "TEAM" }) mode: OrganizationMode;
  @CreateDateColumn({ name: "created_at", type: "timestamptz" }) createdAt: Date;
}
