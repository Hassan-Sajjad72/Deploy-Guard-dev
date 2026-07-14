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
import { ProjectPipelineRun } from "../projects/project-pipeline-run.entity";
import { Project } from "../projects/project.entity";

@Entity("project_pipeline_metric_summaries")
export class ProjectPipelineMetricSummary {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Index()
  @Column({ name: "project_id" })
  projectId: string;

  @ManyToOne(() => Project, { nullable: false, onDelete: "CASCADE" })
  @JoinColumn({ name: "project_id" })
  project: Project;

  @Index()
  @Column({ name: "pipeline_run_id" })
  pipelineRunId: string;

  @ManyToOne(() => ProjectPipelineRun, { nullable: false, onDelete: "CASCADE" })
  @JoinColumn({ name: "pipeline_run_id" })
  pipelineRun: ProjectPipelineRun;

  @Column({ nullable: true, name: "total_duration_ms" })
  totalDurationMs: number;

  @Column({ nullable: true, name: "github_actions_duration_ms" })
  githubActionsDurationMs: number;

  @Column({ nullable: true, name: "docker_build_duration_ms" })
  dockerBuildDurationMs: number;

  @Column({ nullable: true, name: "trivy_scan_duration_ms" })
  trivyScanDurationMs: number;

  @Column({ nullable: true, name: "ecr_push_duration_ms" })
  ecrPushDurationMs: number;

  @Column({ nullable: true, name: "terraform_plan_duration_ms" })
  terraformPlanDurationMs: number;

  @Column({ nullable: true, name: "terraform_apply_duration_ms" })
  terraformApplyDurationMs: number;

  @Column({ nullable: true, name: "finops_duration_ms" })
  finopsDurationMs: number;

  @Column({ nullable: true, name: "ecs_deployment_duration_ms" })
  ecsDeploymentDurationMs: number;

  @Column({ nullable: true, name: "alb_health_check_duration_ms" })
  albHealthCheckDurationMs: number;

  @Column({ nullable: true, name: "rollback_duration_ms" })
  rollbackDurationMs: number;

  @Column()
  status: string;

  @Column({ nullable: true, type: "jsonb" })
  metadata: Record<string, unknown> | null;

  @CreateDateColumn({ name: "created_at" })
  createdAt: Date;

  @UpdateDateColumn({ name: "updated_at" })
  updatedAt: Date;
}
