import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from "typeorm";

@Entity("audit_logs")
export class AuditLog {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Index()
  @Column({ nullable: true, name: "actor_user_id" })
  actorUserId: string;

  @Column({ nullable: true, name: "actor_email" })
  actorEmail: string;

  @Column({ nullable: true, name: "actor_role" })
  actorRole: string;

  @Index()
  @Column()
  action: string;

  @Index()
  @Column({ name: "resource_type" })
  resourceType: string;

  @Column({ nullable: true, name: "resource_id" })
  resourceId: string;

  @Index()
  @Column()
  status: string;

  @Column({ nullable: true, name: "ip_address" })
  ipAddress: string;

  @Column({ nullable: true, name: "user_agent" })
  userAgent: string;

  @Column({ type: "jsonb", nullable: true })
  metadata: Record<string, unknown> | null;

  @CreateDateColumn({ name: "created_at" })
  createdAt: Date;
}
