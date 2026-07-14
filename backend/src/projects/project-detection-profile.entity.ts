import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from "typeorm";
import { Project } from "./project.entity";

export enum DetectionStatus {
  SUCCESS = "success",
  NEEDS_MANUAL_DOCKERFILE = "needs_manual_dockerfile",
  FAILED = "failed",
}

export enum DetectionConfidence {
  HIGH = "high",
  MEDIUM = "medium",
  LOW = "low",
}

@Entity("project_detection_profiles")
@Unique(["projectId"])
export class ProjectDetectionProfile {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Index()
  @Column({ name: "project_id" })
  projectId: string;

  @ManyToOne(() => Project, { nullable: false, onDelete: "CASCADE" })
  @JoinColumn({ name: "project_id" })
  project: Project;

  @Column({ name: "repository_url" })
  repositoryUrl: string;

  @Column({ nullable: true, name: "repository_full_name" })
  repositoryFullName: string;

  @Column({ name: "target_branch" })
  targetBranch: string;

  @Column({ nullable: true, name: "commit_sha" })
  commitSha: string;

  @Column()
  ecosystem: string;

  @Column({ nullable: true })
  language: string;

  @Column({ nullable: true })
  framework: string;

  @Column({ nullable: true, name: "framework_variant" })
  frameworkVariant: string;

  @Column({ nullable: true, name: "package_manager" })
  packageManager: string;

  @Column({ nullable: true, name: "runtime_version" })
  runtimeVersion: string;

  @Column({ nullable: true, name: "build_command" })
  buildCommand: string;

  @Column({ nullable: true, name: "start_command" })
  startCommand: string;

  @Column({ nullable: true, name: "expected_port" })
  expectedPort: number;

  @Column({ nullable: true, name: "health_check_path" })
  healthCheckPath: string;

  @Column({ default: false, name: "requires_database" })
  requiresDatabase: boolean;

  @Column({ nullable: true, name: "database_type" })
  databaseType: string;

  @Column({ default: false, name: "requires_persistent_storage" })
  requiresPersistentStorage: boolean;

  @Column({ default: false, name: "static_output" })
  staticOutput: boolean;

  @Column({ default: false, name: "dockerfile_required" })
  dockerfileRequired: boolean;

  @Column({ default: false, name: "has_dockerfile" })
  hasDockerfile: boolean;

  @Column({ nullable: true, name: "selected_template" })
  selectedTemplate: string;

  @Column()
  confidence: string;

  @Column({ name: "detection_status" })
  detectionStatus: string;

  @Column({ type: "jsonb", nullable: true })
  warnings: string[] | null;

  @Column({ type: "jsonb", nullable: true })
  errors: string[] | null;

  @Column({ type: "jsonb", nullable: true, name: "raw_profile" })
  rawProfile: Record<string, unknown> | null;

  @CreateDateColumn({ name: "created_at" })
  createdAt: Date;

  @UpdateDateColumn({ name: "updated_at" })
  updatedAt: Date;
}
