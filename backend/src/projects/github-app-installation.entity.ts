import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from "typeorm";

@Entity("github_app_installations")
@Index("UQ_github_app_installations_owner_installation", ["ownerUserId", "installationId"], { unique: true })
export class GithubAppInstallation {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Index()
  @Column({ name: "owner_user_id" })
  ownerUserId: number;

  @Column({ name: "installation_id", type: "bigint" })
  installationId: string;

  @Column({ name: "account_login" })
  accountLogin: string;

  @Column({ name: "account_id", type: "bigint", nullable: true })
  accountId: string | null;

  @Column({ default: "active" })
  status: string;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt: Date;

  @UpdateDateColumn({ name: "updated_at", type: "timestamptz" })
  updatedAt: Date;
}
