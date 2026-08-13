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
import { ProjectDeployment } from "../orchestration/project-deployment.entity";
import { ProjectPipelineRun } from "../projects/project-pipeline-run.entity";
import { Project } from "../projects/project.entity";
import { User } from "../users/user.entity";

export enum LogStreamSessionStatus {
  STARTED = "started",
  ACTIVE = "active",
  STOPPED = "stopped",
  FAILED = "failed",
}

export enum LogStreamSessionSource {
  CLOUDWATCH_LOGS = "cloudwatch_logs",
  MOCK = "mock",
}

@Entity("project_log_stream_sessions")
export class ProjectLogStreamSession {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Index()
  @Column({ name: "project_id" })
  projectId: string;

  @ManyToOne(() => Project, { nullable: false, onDelete: "CASCADE" })
  @JoinColumn({ name: "project_id" })
  project: Project;

  @Column({ nullable: true, name: "pipeline_run_id" })
  pipelineRunId: string;

  @ManyToOne(() => ProjectPipelineRun, { nullable: true, onDelete: "SET NULL" })
  @JoinColumn({ name: "pipeline_run_id" })
  pipelineRun: ProjectPipelineRun;

  @Column({ nullable: true, name: "deployment_id" })
  deploymentId: string;

  @ManyToOne(() => ProjectDeployment, { nullable: true, onDelete: "SET NULL" })
  @JoinColumn({ name: "deployment_id" })
  deployment: ProjectDeployment;

  @Column({ nullable: true, name: "user_id" })
  userId: number;

  @ManyToOne(() => User, { nullable: true, onDelete: "SET NULL" })
  @JoinColumn({ name: "user_id" })
  user: User;

  @Column({ default: LogStreamSessionStatus.STARTED })
  status: string;

  @Column({ default: LogStreamSessionSource.CLOUDWATCH_LOGS })
  source: string;

  @Column({ nullable: true, name: "log_group_name" })
  logGroupName: string;

  @Column({ nullable: true, name: "log_stream_name" })
  logStreamName: string;

  @Column({ name: "started_at", type: "timestamptz" })
  startedAt: Date;

  @Column({ nullable: true, name: "stopped_at", type: "timestamptz" })
  stoppedAt: Date;

  @Column({ nullable: true, name: "error_message", type: "text" })
  errorMessage: string;

  @Column({ nullable: true, type: "jsonb" })
  metadata: Record<string, unknown> | null;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt: Date;

  @UpdateDateColumn({ name: "updated_at", type: "timestamptz" })
  updatedAt: Date;
}
