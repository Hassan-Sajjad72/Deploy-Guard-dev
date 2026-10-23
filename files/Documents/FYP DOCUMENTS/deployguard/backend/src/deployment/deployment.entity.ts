import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, ManyToOne } from 'typeorm';
import { User } from '../auth/user.entity';

export enum DeploymentStatus {
  PENDING = 'pending', BUILDING = 'building', DEPLOYING = 'deploying',
  RUNNING = 'running', FAILED = 'failed', STOPPED = 'stopped', ROLLED_BACK = 'rolled_back',
}
export enum DeploymentMode { SINGLE = 'single', MULTI = 'multi', DATABASE = 'database' }

@Entity('deployments')
export class Deployment {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column() name: string;
  @Column() repositoryUrl: string;
  @Column({ default: 'main' }) branch: string;
  @Column({ nullable: true }) dockerfilePath: string;
  @Column({ type: 'enum', enum: DeploymentMode, default: DeploymentMode.SINGLE }) mode: DeploymentMode;
  @Column({ type: 'enum', enum: DeploymentStatus, default: DeploymentStatus.PENDING }) status: DeploymentStatus;
  @Column({ nullable: true }) ecrImageUri: string;
  @Column({ nullable: true }) ecsServiceArn: string;
  @Column({ nullable: true }) albDnsName: string;
  @Column({ type: 'jsonb', nullable: true }) config: Record<string, any>;
  @Column({ type: 'text', nullable: true }) logs: string;
  @Column({ nullable: true }) errorMessage: string;
  @ManyToOne(() => User, { eager: true }) user: User;
  @CreateDateColumn() createdAt: Date;
  @UpdateDateColumn() updatedAt: Date;
}
