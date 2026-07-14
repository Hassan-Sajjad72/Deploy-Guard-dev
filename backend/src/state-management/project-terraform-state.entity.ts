import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from "typeorm";
import { ProjectInfrastructureEnvironment } from "../infrastructure/project-infrastructure-environment.entity";
import { Project } from "../projects/project.entity";

export enum TerraformStateStatus {
  ACTIVE = "active",
  MISSING = "missing",
  CORRUPTED = "corrupted",
  RECOVERY_REQUIRED = "recovery_required",
  RECOVERED = "recovered",
  FAILED = "failed",
}

@Entity("project_terraform_states")
export class ProjectTerraformState {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Index()
  @Column({ name: "project_id" })
  projectId: string;

  @ManyToOne(() => Project, { nullable: false, onDelete: "CASCADE" })
  @JoinColumn({ name: "project_id" })
  project: Project;

  @Column({ nullable: true, name: "infrastructure_environment_id" })
  infrastructureEnvironmentId: string;

  @ManyToOne(() => ProjectInfrastructureEnvironment, { nullable: true, onDelete: "SET NULL" })
  @JoinColumn({ name: "infrastructure_environment_id" })
  infrastructureEnvironment: ProjectInfrastructureEnvironment;

  @Column({ default: "dev", name: "environment_name" })
  environmentName: string;

  @Column({ name: "state_bucket" })
  stateBucket: string;

  @Column({ name: "state_key" })
  stateKey: string;

  @Column({ name: "state_region" })
  stateRegion: string;

  @Column({ nullable: true, name: "current_version_id" })
  currentVersionId: string;

  @Column({ nullable: true, name: "previous_version_id" })
  previousVersionId: string;

  @Column({ nullable: true })
  checksum: string;

  @Column({ nullable: true, name: "resource_count" })
  resourceCount: number;

  @Column({ nullable: true, name: "dependency_graph_hash" })
  dependencyGraphHash: string;

  @Column({ default: TerraformStateStatus.MISSING })
  status: string;

  @Column({ nullable: true, name: "last_validated_at", type: "timestamp" })
  lastValidatedAt: Date;

  @Column({ nullable: true, type: "jsonb" })
  metadata: Record<string, unknown> | null;

  @CreateDateColumn({ name: "created_at" })
  createdAt: Date;

  @UpdateDateColumn({ name: "updated_at" })
  updatedAt: Date;
}
