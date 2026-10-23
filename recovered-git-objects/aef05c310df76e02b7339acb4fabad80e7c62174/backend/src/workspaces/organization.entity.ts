import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from "typeorm";

@Entity("organizations")
export class Organization {
  @PrimaryGeneratedColumn("uuid") id: string;
  @Column() name: string;
  @Column() kind: "personal" | "team" | "agency";
  @Index({ unique: true })
  @Column({ name: "personal_owner_user_id", nullable: true, type: "integer" }) personalOwnerUserId: number | null;
  @CreateDateColumn({ name: "created_at", type: "timestamptz" }) createdAt: Date;
}
