import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from "typeorm";

@Entity("organizations")
export class Organization {
  @PrimaryGeneratedColumn("uuid") id: string;
  @Column() name: string;
  @Column() kind: "personal" | "team" | "agency";
  @Column({ name: "archived_at", type: "timestamptz", nullable: true }) archivedAt: Date | null;
  @Column({ name: "archive_reason", nullable: true }) archiveReason: string | null;
  @Index({ unique: true })
  @Column({ name: "personal_owner_user_id", nullable: true, type: "integer" }) personalOwnerUserId: number | null;
  @CreateDateColumn({ name: "created_at", type: "timestamptz" }) createdAt: Date;
}
