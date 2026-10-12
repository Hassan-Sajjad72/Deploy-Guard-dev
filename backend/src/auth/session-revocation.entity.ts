import { Column, Entity, Index, PrimaryColumn } from "typeorm";

@Entity("auth_session_revocations")
export class SessionRevocation {
  @PrimaryColumn({ name: "token_hash", length: 64 })
  tokenHash: string;

  @Index()
  @Column({ name: "expires_at", type: "timestamptz" })
  expiresAt: Date;
}
