import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from "typeorm";
import { ProjectDeployment } from "../orchestration/project-deployment.entity";
import { ProjectPipelineRun } from "../projects/project-pipeline-run.entity";
import { Project } from "../projects/project.entity";

export enum RuntimeMetricSource {
  PROMETHEUS = "prometheus",
  CLOUDWATCH = "cloudwatch",
  ECS = "ecs",
  ALB = "alb",
}

@Entity("project_runtime_metric_snapshots")
export class ProjectRuntimeMetricSnapshot {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Index()
  @Column({ name: "project_id" })
  projectId: string;

  @ManyToOne(() => Project, { nullable: false, onDelete: "CASCADE" })
  @JoinColumn({ name: "project_id" })
  project: Project;

  @Column({ nullable: true, name: "deployment_id" })
  deploymentId: string;

  @ManyToOne(() => ProjectDeployment, { nullable: true, onDelete: "SET NULL" })
  @JoinColumn({ name: "deployment_id" })
  deployment: ProjectDeployment;

  @Column({ nullable: true, name: "pipeline_run_id" })
  pipelineRunId: string;

  @ManyToOne(() => ProjectPipelineRun, { nullable: true, onDelete: "SET NULL" })
  @JoinColumn({ name: "pipeline_run_id" })
  pipelineRun: ProjectPipelineRun;

  @Column()
  source: string;

  @Index()
  @Column({ name: "metric_name" })
  metricName: string;

  @Column({ nullable: true, name: "metric_unit" })
  metricUnit: string;

  @Column({ type: "numeric", transformer: { to: (value) => value, from: (value) => Number(value) } })
  value: number;

  @Index()
  @Column({ type: "timestamp" })
  timestamp: Date;

  @Column({ nullable: true, type: "jsonb" })
  labels: Record<string, unknown> | null;

  @Column({ nullable: true, type: "jsonb" })
  metadata: Record<string, unknown> | null;

  @CreateDateColumn({ name: "created_at" })
  createdAt: Date;
}
