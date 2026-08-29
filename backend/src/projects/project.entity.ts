import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from "typeorm";
import { User } from "../users/user.entity";
import { ProjectEnvironmentVariable } from "./project-environment-variable.entity";

export enum ProjectStatus {
  CREATED = "created",
  CONFIGURED = "configured",
  ARCHIVED = "archived",
}

export enum ProjectVisibility {
  PRIVATE = "private",
  WORKSPACE = "workspace",
}

export type ProjectDeploymentOverrides = {
  installCommand?: string;
  buildCommand?: string;
  startCommand?: string;
  outputDirectory?: string;
  port?: number;
  healthCheckPath?: string;
  runtimeType?: "static" | "server";
  requiredEnvironmentVariables?: string[];
  dockerfileMode?: "generated" | "custom";
};

@Entity("projects")
export class Project {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Index("IDX_projects_deletion_intent")
  @Column({ name: "owner_user_id" })
  ownerUserId: number;

  @ManyToOne(() => User, { nullable: false, onDelete: "CASCADE" })
  @JoinColumn({ name: "owner_user_id" })
  owner: User;

  @Column()
  name: string;

  @Column({ nullable: true })
  description: string;

  @Column({ name: "repository_url" })
  repositoryUrl: string;

  @Column({ default: "github", name: "repository_provider" })
  repositoryProvider: string;

  @Index()
  @Column({ nullable: true, name: "github_repository_id" })
  githubRepositoryId: string | null;

  @Index()
  @Column({ nullable: true, name: "github_installation_id", type: "bigint" })
  githubInstallationId: string | null;

  @Index()
  @Column({ nullable: true, name: "repository_full_name" })
  repositoryFullName: string;

  @Column({ default: "main", name: "target_branch" })
  targetBranch: string;

  @Column({ default: "dev", name: "environment_name" })
  environmentName: string;

  @Column({ nullable: true, name: "app_directory" })
  appDirectory: string;

  @Column({ type: "jsonb", default: {}, name: "deployment_overrides" })
  deploymentOverrides: ProjectDeploymentOverrides;

  @Column({
    type: "enum",
    enum: ProjectStatus,
    default: ProjectStatus.CREATED,
  })
  status: ProjectStatus;

  @Column({
    type: "enum",
    enum: ProjectVisibility,
    default: ProjectVisibility.PRIVATE,
  })
  visibility: ProjectVisibility;

  @OneToMany(() => ProjectEnvironmentVariable, (variable) => variable.project)
  environmentVariables: ProjectEnvironmentVariable[];

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt: Date;

  @UpdateDateColumn({ name: "updated_at", type: "timestamptz" })
  updatedAt: Date;

  @Column({ nullable: true, name: "archived_at", type: "timestamptz" })
  archivedAt: Date;

  @Column({ nullable: true, name: "deletion_fence_token", type: "bigint" })
  deletionFenceToken: string | null;

  @Index()
  @Column({ nullable: true, name: "deletion_intent_id", type: "uuid" })
  deletionIntentId: string | null;

  @Column({ nullable: true, name: "deletion_started_at", type: "timestamptz" })
  deletionStartedAt: Date | null;
}
