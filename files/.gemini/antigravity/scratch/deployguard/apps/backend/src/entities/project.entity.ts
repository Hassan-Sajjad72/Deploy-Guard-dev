// ═══════════════════════════════════════════════════
// Project Entity — Linked GitHub repositories
// ═══════════════════════════════════════════════════

import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  OneToMany,
  JoinColumn,
  Index,
} from 'typeorm';
import { ProjectStatus } from '@deployguard/shared-types';
import type { IDetectedStack, IDeploymentProfile } from '@deployguard/shared-types';
import { User } from './user.entity';
import { Deployment } from './deployment.entity';
import { EnvironmentVariable } from './environment-variable.entity';

@Entity('projects')
export class Project {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 255 })
  name: string;

  @Column({ type: 'text', nullable: true })
  description: string | null;

  @Column({ type: 'varchar', length: 500 })
  githubRepoUrl: string;

  @Column({ type: 'varchar', length: 64 })
  @Index('IDX_PROJECT_GITHUB_REPO_ID')
  githubRepoId: string;

  @Column({ type: 'varchar', length: 255, default: 'main' })
  defaultBranch: string;

  @Column({ type: 'varchar', length: 255, default: 'main' })
  selectedBranch: string;

  // Stack detection output stored as JSONB for flexible querying
  @Column({ type: 'jsonb', nullable: true })
  detectedStack: IDetectedStack | null;

  // Pre-flight deployment configuration
  @Column({ type: 'jsonb', nullable: true })
  deploymentProfile: IDeploymentProfile | null;

  @Column({
    type: 'enum',
    enum: ProjectStatus,
    default: ProjectStatus.ACTIVE,
  })
  @Index('IDX_PROJECT_STATUS')
  status: ProjectStatus;

  @Column({ type: 'uuid' })
  @Index('IDX_PROJECT_OWNER')
  ownerId: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;

  // ── Relations ───────────────────────────────────

  @ManyToOne(() => User, (user) => user.projects, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'ownerId' })
  owner: User;

  @OneToMany(() => Deployment, (deployment) => deployment.project)
  deployments: Deployment[];

  @OneToMany(() => EnvironmentVariable, (envVar) => envVar.project)
  environmentVariables: EnvironmentVariable[];
}
