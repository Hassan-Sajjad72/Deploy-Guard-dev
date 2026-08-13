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
import { decimalTransformer } from "./decimal.transformer";
import { ProjectCostEstimate } from "./project-cost-estimate.entity";

export enum CostResourceType {
  ECS_FARGATE_COMPUTE = "ecs_fargate_compute",
  LOAD_BALANCER = "load_balancer",
  DATABASE = "database",
  STORAGE = "storage",
  DATA_TRANSFER = "data_transfer",
  CLOUDWATCH_LOGS = "cloudwatch_logs",
  NAT_GATEWAY = "nat_gateway",
  OTHER = "other",
}

@Entity("project_cost_resource_breakdowns")
export class ProjectCostResourceBreakdown {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Index()
  @Column({ name: "estimate_id" })
  estimateId: string;

  @ManyToOne(() => ProjectCostEstimate, (estimate) => estimate.breakdowns, {
    nullable: false,
    onDelete: "CASCADE",
  })
  @JoinColumn({ name: "estimate_id" })
  estimate: ProjectCostEstimate;

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

  @Column({ name: "resource_type" })
  resourceType: string;

  @Column({ name: "resource_name" })
  resourceName: string;

  @Column({ default: "aws" })
  provider: string;

  @Column({ nullable: true, name: "service_name" })
  serviceName: string;

  @Column({ name: "monthly_cost", type: "numeric", precision: 12, scale: 2, default: 0, transformer: decimalTransformer })
  monthlyCost: number;

  @Column({ nullable: true, name: "hourly_cost", type: "numeric", precision: 12, scale: 4, transformer: decimalTransformer })
  hourlyCost: number;

  @Column({ nullable: true })
  unit: string;

  @Column({ nullable: true, type: "numeric", precision: 12, scale: 2, transformer: decimalTransformer })
  quantity: number;

  @Column({ nullable: true, type: "jsonb" })
  metadata: Record<string, unknown> | null;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt: Date;

  @UpdateDateColumn({ name: "updated_at", type: "timestamptz" })
  updatedAt: Date;
}
