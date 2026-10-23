// ═══════════════════════════════════════════════════
// User Entity — GitHub-authenticated platform users
// ═══════════════════════════════════════════════════

import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  OneToMany,
  Index,
} from 'typeorm';
import { UserRole, SubscriptionTier } from '@deployguard/shared-types';
import { Project } from './project.entity';
import { Deployment } from './deployment.entity';
import { AuditLog } from './audit-log.entity';

@Entity('users')
export class User {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 64, unique: true })
  @Index('IDX_USER_GITHUB_ID', { unique: true })
  githubId: string;

  @Column({ type: 'varchar', length: 255, unique: true })
  @Index('IDX_USER_EMAIL', { unique: true })
  email: string;

  @Column({ type: 'varchar', length: 100 })
  username: string;

  @Column({ type: 'varchar', length: 255 })
  displayName: string;

  @Column({ type: 'varchar', length: 500, nullable: true })
  avatarUrl: string | null;

  @Column({
    type: 'enum',
    enum: UserRole,
    default: UserRole.DEVELOPER,
  })
  role: UserRole;

  // Encrypted GitHub access token — never expose in API responses
  @Column({ type: 'text', select: false })
  accessToken: string;

  // Encrypted GitHub refresh token
  @Column({ type: 'text', nullable: true, select: false })
  refreshToken: string | null;

  @Column({
    type: 'enum',
    enum: SubscriptionTier,
    default: SubscriptionTier.FREE,
  })
  tier: SubscriptionTier;

  @Column({ type: 'boolean', default: true })
  isActive: boolean;

  @Column({ type: 'timestamptz', nullable: true })
  lastLoginAt: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;

  // ── Relations ───────────────────────────────────

  @OneToMany(() => Project, (project) => project.owner)
  projects: Project[];

  @OneToMany(() => Deployment, (deployment) => deployment.triggeredBy)
  deployments: Deployment[];

  @OneToMany(() => AuditLog, (log) => log.user)
  auditLogs: AuditLog[];
}
