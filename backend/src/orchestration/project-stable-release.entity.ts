import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn, UpdateDateColumn } from "typeorm";
import { Project } from "../projects/project.entity";

export enum StableReleaseStatus {
  STABLE = "stable",
  SUPERSEDED = "superseded",
  ROLLBACK_TARGET = "rollback_target",
  INVALID = "invalid",
}

@Entity("project_stable_releases")
export class ProjectStableRelease {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Index()
  @Column({ name: "project_id" })
  projectId: string;

  @ManyToOne(() => Project, { nullable: false, onDelete: "CASCADE" })
  @JoinColumn({ name: "project_id" })
  project: Project;

  @Column({ default: "dev", name: "environment_name" })
  environmentName: string;

  @Column({ name: "commit_sha" })
  commitSha: string;

  @Column({ name: "short_commit_sha" })
  shortCommitSha: string;

  @Column({ name: "image_uri" })
  imageUri: string;

  @Column({ name: "task_definition_arn" })
  taskDefinitionArn: string;

  @Column({ nullable: true, name: "ecs_service_arn" })
  ecsServiceArn: string;

  @Column({ default: "/health", name: "health_check_path" })
  healthCheckPath: string;

  @Column({ nullable: true, name: "app_port" })
  appPort: number;

  @Column({ nullable: true, name: "deployed_by_pipeline_run_id" })
  deployedByPipelineRunId: string;

  @Column({ name: "deployed_at", type: "timestamp" })
  deployedAt: Date;

  @Column({ default: StableReleaseStatus.STABLE })
  status: string;

  @Column({ nullable: true, type: "jsonb" })
  metadata: Record<string, unknown> | null;

  @CreateDateColumn({ name: "created_at" })
  createdAt: Date;

  @UpdateDateColumn({ name: "updated_at" })
  updatedAt: Date;
}
