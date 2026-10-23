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
import { ProjectDetectionProfile } from "./project-detection-profile.entity";
import { ProjectPreflightReport } from "./project-preflight-report.entity";
import { Project } from "./project.entity";
import { ProjectPipelineEvent } from "./project-pipeline-event.entity";

export enum PipelineRunStatus {
  QUEUED = "queued",
  RUNNING = "running",
  COMPLETED = "completed",
  FAILED = "failed",
  CANCELLED = "cancelled",
}

@Entity("project_pipeline_runs")
export class ProjectPipelineRun {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Index()
  @Column({ name: "project_id" })
  projectId: string;

  @ManyToOne(() => Project, { nullable: false, onDelete: "CASCADE" })
  @JoinColumn({ name: "project_id" })
  project: Project;

  @Index()
  @Column({ name: "triggered_by_user_id" })
  triggeredByUserId: number;

  @ManyToOne(() => User, { nullable: false, onDelete: "CASCADE" })
  @JoinColumn({ name: "triggered_by_user_id" })
  triggeredByUser: User;

  @Column({ nullable: true, name: "preflight_report_id" })
  preflightReportId: string;

  @ManyToOne(() => ProjectPreflightReport, { nullable: true, onDelete: "SET NULL" })
  @JoinColumn({ name: "preflight_report_id" })
  preflightReport: ProjectPreflightReport;

  @Column({ nullable: true, name: "detection_profile_id" })
  detectionProfileId: string;

  @ManyToOne(() => ProjectDetectionProfile, { nullable: true, onDelete: "SET NULL" })
  @JoinColumn({ name: "detection_profile_id" })
  detectionProfile: ProjectDetectionProfile;

  @Column({ name: "repository_url" })
  repositoryUrl: string;

  @Column({ nullable: true, name: "repository_full_name" })
  repositoryFullName: string;

  @Column({ name: "target_branch" })
  targetBranch: string;

  @Column({ nullable: true, name: "commit_sha" })
  commitSha: string;

  @Column({ nullable: true, name: "image_name" })
  imageName: string;

  @Column({ nullable: true, name: "image_tag" })
  imageTag: string;

  @Column({ nullable: true, name: "ecr_repository_name" })
  ecrRepositoryName: string;

  @Column({ nullable: true, name: "ecr_image_uri" })
  ecrImageUri: string;

  @Column({ nullable: true, name: "github_workflow_run_id" })
  githubWorkflowRunId: string;

  @Column({ nullable: true, name: "github_workflow_status" })
  githubWorkflowStatus: string;

  @Column({
    type: "enum",
    enum: PipelineRunStatus,
    default: PipelineRunStatus.QUEUED,
  })
  status: PipelineRunStatus;

  @Column({ nullable: true, name: "current_stage" })
  currentStage: string;

  @Column({ nullable: true, name: "started_at", type: "timestamp" })
  startedAt: Date;

  @Column({ nullable: true, name: "completed_at", type: "timestamp" })
  completedAt: Date;

  @Column({ nullable: true, name: "failed_at", type: "timestamp" })
  failedAt: Date;

  @Column({ nullable: true, name: "error_message", type: "text" })
  errorMessage: string;

  @Column({ nullable: true, type: "jsonb" })
  metadata: Record<string, unknown> | null;

  @OneToMany(() => ProjectPipelineEvent, (event) => event.pipelineRun)
  events: ProjectPipelineEvent[];

  @CreateDateColumn({ name: "created_at" })
  createdAt: Date;

  @UpdateDateColumn({ name: "updated_at" })
  updatedAt: Date;
}
