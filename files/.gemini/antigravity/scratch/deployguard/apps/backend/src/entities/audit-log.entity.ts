// ═══════════════════════════════════════════════════
// AuditLog Entity — Immutable action trail
// ═══════════════════════════════════════════════════
// Append-only table — no updates or deletes.
// Captures who did what, when, and from where.

import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { AuditAction, ResourceType } from '@deployguard/shared-types';
import { User } from './user.entity';

@Entity('audit_logs')
export class AuditLog {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid', nullable: true })
  @Index('IDX_AUDIT_USER')
  userId: string | null;

  @Column({
    type: 'enum',
    enum: AuditAction,
  })
  @Index('IDX_AUDIT_ACTION')
  action: AuditAction;

  @Column({
    type: 'enum',
    enum: ResourceType,
  })
  resourceType: ResourceType;

  @Column({ type: 'varchar', length: 255, nullable: true })
  @Index('IDX_AUDIT_RESOURCE')
  resourceId: string | null;

  // Arbitrary details blob — e.g., before/after diff, request params
  @Column({ type: 'jsonb', nullable: true })
  details: Record<string, unknown> | null;

  @Column({ type: 'varchar', length: 45, nullable: true })
  ipAddress: string | null;

  @Column({ type: 'text', nullable: true })
  userAgent: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  @Index('IDX_AUDIT_CREATED')
  createdAt: Date;

  // ── Relations ───────────────────────────────────

  @ManyToOne(() => User, (user) => user.auditLogs, {
    onDelete: 'SET NULL',
    nullable: true,
  })
  @JoinColumn({ name: 'userId' })
  user: User | null;
}
