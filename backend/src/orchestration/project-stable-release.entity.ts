import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn, UpdateDateColumn } from "typeorm";
import { Project } from "../projects/project.entity";

export enum StableReleaseStatus {
  STABLE = "stable",
  SUPERSEDED = "superseded",
  ROLLBACK_TARGET = "rollback_target",
  INVALID = "invalid",
}

@Entity("project_stable_releases")
@Index(
  "UQ_project_stable_release_scope",
  ["projectId", "environmentName"],
  { unique: true, where: `"status" = 'stable'` },
)
@Index(
  "UQ_project_stable_release_manifest_projection",
  ["releaseManifestId"],
  { unique: true, where: `"release_manifest_id" IS NOT NULL` },
)
@Index(
  "UQ_project_stable_release_operation",
  ["deployedByPipelineRunId"],
  { unique: true, where: `"deployed_by_pipeline_run_id" IS NOT NULL` },
)
export class ProjectStableRelease {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Index()
  @Column({ name: "project_id" })
  projectId: string;

  @ManyToOne(() => Project, { nullable: false, onDelete: "CASCADE" })
  @JoinColumn({ name: "project_id" })
  project: Project;

  @Index("IDX_project_stable_releases_generation")
  @Column({ nullable: true, name: "generation_id", type: "uuid" })
  generationId: string | null;

  @Index("IDX_project_stable_releases_release_manifest")
  @Column({ nullable: true, name: "release_manifest_id", type: "uuid" })
  releaseManifestId: string | null;

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

  @Column({
    nullable: true,
    name: "deployed_by_pipeline_run_id",
    type: "uuid",
  })
  deployedByPipelineRunId: string;

  @Column({ name: "deployed_at", type: "timestamptz" })
  deployedAt: Date;

  @Column({ default: StableReleaseStatus.STABLE })
  status: string;

  @Column({ nullable: true, type: "jsonb" })
  metadata: Record<string, unknown> | null;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt: Date;

  @UpdateDateColumn({ name: "updated_at", type: "timestamptz" })
  updatedAt: Date;
}
