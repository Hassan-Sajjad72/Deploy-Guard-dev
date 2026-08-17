import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from "typeorm";

@Entity("central_cleanup_challenges")
export class CentralCleanupChallenge {
  @PrimaryGeneratedColumn("uuid") id: string;
  @Index() @Column({ name: "user_id" }) userId: number;
  @Column() action: "selected" | "safe_orphans" | "emergency_non_production";
  @Column({ name: "token_hash" }) tokenHash: string;
  @Column({ name: "confirmation_phrase" }) confirmationPhrase: string;
  @Column({ name: "expires_at", type: "timestamptz" }) expiresAt: Date;
  @Column({ name: "used_at", type: "timestamptz", nullable: true }) usedAt: Date | null;
  @CreateDateColumn({ name: "created_at", type: "timestamptz" }) createdAt: Date;
}
