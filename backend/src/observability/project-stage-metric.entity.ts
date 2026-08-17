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

export enum StageMetricStatus {
  PENDING = "pending",
  RUNNING = "running",
  SUCCEEDED = "succeeded",
  FAILED = "failed",
  SKIPPED = "skipped",
  CANCELLED = "cancelled",
}

export enum StageMetricSource {
  PIPELINE = "pipeline",
  GITHUB_ACTIONS = "github_actions",
  TRIVY = "trivy",
  DOCKER = "docker",
  ECR = "ecr",
  TERRAFORM = "terraform",
  FINOPS = "finops",
  ECS = "ecs",
  ALB = "alb",
  ROLLBACK = "rollback",
  MANUAL = "manual",
}

@Entity("project_stage_metrics")
export class ProjectStageMetric {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Index()
  @Column({ name: "project_id" })
  projectId: string;

  @ManyToOne(() => Project, { nullable: false, onDelete: "CASCADE" })
  @JoinColumn({ name: "project_id" })
  project: Project;

  @Index()
  @Column({ nullable: true, name: "pipeline_run_id" })
  pipelineRunId: string;

  @ManyToOne(() => ProjectPipelineRun, { nullable: true, onDelete: "SET NULL" })
  @JoinColumn({ name: "pipeline_run_id" })
  pipelineRun: ProjectPipelineRun;

  @Index()
  @Column({ nullable: true, name: "deployment_id" })
  deploymentId: string;

  @ManyToOne(() => ProjectDeployment, { nullable: true, onDelete: "SET NULL" })
  @JoinColumn({ name: "deployment_id" })
  deployment: ProjectDeployment;

  @Index()
  @Column({ name: "stage_name" })
  stageName: string;

  @Column({ default: StageMetricStatus.PENDING })
  status: string;

  @Column({ nullable: true, name: "started_at", type: "timestamptz" })
  startedAt: Date;

  @Column({ nullable: true, name: "ended_at", type: "timestamptz" })
  endedAt: Date;

  @Column({ nullable: true, name: "duration_ms" })
  durationMs: number;

  @Column({ default: StageMetricSource.PIPELINE })
  source: string;

  @Column({ nullable: true, type: "jsonb" })
  metadata: Record<string, unknown> | null;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt: Date;

  @UpdateDateColumn({ name: "updated_at", type: "timestamptz" })
  updatedAt: Date;
}
