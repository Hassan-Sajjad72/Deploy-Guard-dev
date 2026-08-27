import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from "typeorm";
@Entity("infrastructure_destroy_challenges")
export class DestroyChallenge {
  @PrimaryGeneratedColumn("uuid") id: string;
  @Index() @Column({ name: "project_id", type: "uuid" }) projectId: string;
  @Index() @Column({ name: "user_id" }) userId: number;
  @Column({ name: "environment_name" }) environmentName: string;
  @Column({ name: "token_hash" }) tokenHash: string;
  @Column({ name: "confirmation_phrase" }) confirmationPhrase: string;
  @Column({ name: "expires_at", type: "timestamptz" }) expiresAt: Date;
  @Column({ name: "used_at", type: "timestamptz", nullable: true }) usedAt: Date | null;
  @CreateDateColumn({ name: "created_at", type: "timestamptz" }) createdAt: Date;
}
