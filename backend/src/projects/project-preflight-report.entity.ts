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
import { ProjectDetectionProfile } from "./project-detection-profile.entity";
import { Project } from "./project.entity";

export enum PreflightValidationStatus {
  PASSED = "passed",
  PASSED_WITH_WARNINGS = "passed_with_warnings",
  FAILED = "failed",
  MANUAL_DOCKERFILE_REQUIRED = "manual_dockerfile_required",
}

@Entity("project_preflight_reports")
@Unique(["projectId"])
export class ProjectPreflightReport {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Index()
  @Column({ name: "project_id" })
  projectId: string;

  @ManyToOne(() => Project, { nullable: false, onDelete: "CASCADE" })
  @JoinColumn({ name: "project_id" })
  project: Project;

  @Column({ nullable: true, name: "detection_profile_id" })
  detectionProfileId: string;

  @Column({ nullable: true, name: "input_fingerprint" })
  inputFingerprint: string;

  @ManyToOne(() => ProjectDetectionProfile, { nullable: true, onDelete: "SET NULL" })
  @JoinColumn({ name: "detection_profile_id" })
  detectionProfile: ProjectDetectionProfile;

  @Column({ name: "template_key" })
  templateKey: string;

  @Column({ nullable: true, name: "template_display_name" })
  templateDisplayName: string;

  @Column()
  ecosystem: string;

  @Column({ nullable: true })
  framework: string;

  @Column({ nullable: true, name: "framework_variant" })
  frameworkVariant: string;

  @Column({ nullable: true, name: "package_manager" })
  packageManager: string;

  @Column({ nullable: true, name: "runtime_version" })
  runtimeVersion: string;

  @Column({ nullable: true, name: "expected_port" })
  expectedPort: number;

  @Column({ nullable: true, name: "build_command" })
  buildCommand: string;

  @Column({ nullable: true, name: "start_command" })
  startCommand: string;

  @Column({ nullable: true, name: "health_check_path" })
  healthCheckPath: string;

  @Column({ default: false, name: "has_dockerfile" })
  hasDockerfile: boolean;

  @Column({ default: false, name: "dockerfile_required" })
  dockerfileRequired: boolean;

  @Column({ nullable: true, type: "text", name: "generated_dockerfile" })
  generatedDockerfile: string;

  @Column({ type: "jsonb" })
  report: Record<string, unknown>;

  @Column({ name: "validation_status" })
  validationStatus: string;

  @Column({ type: "jsonb", nullable: true })
  warnings: string[] | null;

  @Column({ type: "jsonb", nullable: true })
  errors: string[] | null;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt: Date;

  @UpdateDateColumn({ name: "updated_at", type: "timestamptz" })
  updatedAt: Date;
}
