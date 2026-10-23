// ═══════════════════════════════════════════════════
// EnvironmentVariable Entity — Encrypted env vars
// ═══════════════════════════════════════════════════
// Values are AES-256-GCM encrypted at rest.
// The encryption/decryption happens in the service layer.

import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
  Unique,
} from 'typeorm';
import { Environment } from '@deployguard/shared-types';
import { Project } from './project.entity';

@Entity('environment_variables')
@Unique('UQ_ENV_VAR_PROJECT_KEY_ENV', ['projectId', 'key', 'environment'])
export class EnvironmentVariable {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  @Index('IDX_ENV_VAR_PROJECT')
  projectId: string;

  @Column({ type: 'varchar', length: 255 })
  key: string;

  // AES-256-GCM encrypted value — includes IV + auth tag
  @Column({ type: 'text' })
  encryptedValue: string;

  @Column({ type: 'boolean', default: true })
  isSecret: boolean;

  @Column({
    type: 'enum',
    enum: Environment,
    default: Environment.PRODUCTION,
  })
  environment: Environment;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;

  // ── Relations ───────────────────────────────────

  @ManyToOne(() => Project, (project) => project.environmentVariables, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'projectId' })
  project: Project;
}
