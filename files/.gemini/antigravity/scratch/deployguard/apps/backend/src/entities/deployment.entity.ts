// ═══════════════════════════════════════════════════
// Deployment Entity — Full pipeline execution record
// ═══════════════════════════════════════════════════
// Tracks the entire lifecycle from trigger through
// build → scan → provision → deploy, including
// duration metrics, cost estimates, and rollback refs.

import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { DeploymentStatus } from '@deployguard/shared-types';
import type {
  ITrivyReport,
  IVulnerabilitySummary,
  ICostEstimate,
} from '@deployguard/shared-types';
import { User } from './user.entity';
import { Project } from './project.entity';

@Entity('deployments')
export class Deployment {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  @Index('IDX_DEPLOYMENT_PROJECT')
  projectId: string;

  @Column({ type: 'uuid' })
  triggeredById: string;

  @Column({ type: 'varchar', length: 255 })
  branch: string;

  @Column({ type: 'varchar', length: 40 })
  commitSha: string;

  @Column({
    type: 'enum',
    enum: DeploymentStatus,
    default: DeploymentStatus.PENDING,
  })
  @Index('IDX_DEPLOYMENT_STATUS')
  status: DeploymentStatus;

  // ── Docker ──────────────────────────────────────

  @Column({ type: 'varchar', length: 100, nullable: true })
  dockerTemplate: string | null;

  @Column({ type: 'text', nullable: true })
  dockerfileContent: string | null;

  // ── Security Scanning ───────────────────────────

  @Column({ type: 'jsonb', nullable: true })
  trivyReport: ITrivyReport | null;

  @Column({ type: 'jsonb', nullable: true })
  vulnerabilitySummary: IVulnerabilitySummary | null;

  // ── Cost Estimation ─────────────────────────────

  @Column({ type: 'jsonb', nullable: true })
  costEstimate: ICostEstimate | null;

  // ── Terraform ───────────────────────────────────

  @Column({ type: 'text', nullable: true })
  terraformPlan: string | null;

  // ── AWS Resources ───────────────────────────────

  @Column({ type: 'varchar', length: 500, nullable: true })
  ecsTaskArn: string | null;

  @Column({ type: 'varchar', length: 500, nullable: true })
  ecsServiceArn: string | null;

  @Column({ type: 'varchar', length: 500, nullable: true })
  albDnsName: string | null;

  @Column({ type: 'varchar', length: 500, nullable: true })
  healthCheckUrl: string | null;

  // ── Duration Metrics (milliseconds) ─────────────

  @Column({ type: 'integer', nullable: true })
  buildDurationMs: number | null;

  @Column({ type: 'integer', nullable: true })
  scanDurationMs: number | null;

  @Column({ type: 'integer', nullable: true })
  provisionDurationMs: number | null;

  @Column({ type: 'integer', nullable: true })
  deployDurationMs: number | null;

  // ── Failure & Rollback ──────────────────────────

  @Column({ type: 'text', nullable: true })
  failureReason: string | null;

  // Self-referencing: which deployment this rolled back from
  @Column({ type: 'uuid', nullable: true })
  rollbackFromId: string | null;

  // Extensible metadata for pipeline-specific data
  @Column({ type: 'jsonb', nullable: true })
  metadata: Record<string, unknown> | null;

  // ── Timestamps ──────────────────────────────────

  @Column({ type: 'timestamptz', nullable: true })
  startedAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  completedAt: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;

  // ── Relations ───────────────────────────────────

  @ManyToOne(() => Project, (project) => project.deployments, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'projectId' })
  project: Project;

  @ManyToOne(() => User, (user) => user.deployments, {
    onDelete: 'SET NULL',
  })
  @JoinColumn({ name: 'triggeredById' })
  triggeredBy: User;
}
