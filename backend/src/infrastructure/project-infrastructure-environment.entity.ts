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

export enum InfrastructureEnvironmentStatus {
  NOT_PROVISIONED = "not_provisioned",
  READINESS_FAILED = "readiness_failed",
  QUEUED = "queued",
  PLANNING = "planning",
  PLAN_FAILED = "plan_failed",
  COST_CHECK_REQUIRED = "cost_check_required",
  WAITING_FOR_COST_APPROVAL = "waiting_for_cost_approval",
  PROVISIONING = "provisioning",
  PROVISIONED = "provisioned",
  FAILED = "failed",
  PARTIALLY_PROVISIONED = "partially_provisioned",
  DISABLED_BY_CONFIG = "disabled_by_config",
  DESTROYED = "destroyed",
}

@Entity("project_infrastructure_environments")
export class ProjectInfrastructureEnvironment {
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

  @Column({ default: "dev", name: "environment_name" })
  environmentName: string;

  @Column({ default: InfrastructureEnvironmentStatus.NOT_PROVISIONED })
  status: string;

  @Column({ nullable: true, name: "aws_region" })
  awsRegion: string;

  @Column({ nullable: true, name: "vpc_id" })
  vpcId: string;

  @Column({ nullable: true, name: "public_subnet_ids", type: "jsonb" })
  publicSubnetIds: string[] | null;

  @Column({ nullable: true, name: "private_subnet_ids", type: "jsonb" })
  privateSubnetIds: string[] | null;

  @Column({ nullable: true, name: "internet_gateway_id" })
  internetGatewayId: string;

  @Column({ nullable: true, name: "nat_gateway_ids", type: "jsonb" })
  natGatewayIds: string[] | null;

  @Column({ nullable: true, name: "route_table_ids", type: "jsonb" })
  routeTableIds: Record<string, string> | null;

  @Column({ nullable: true, name: "alb_security_group_id" })
  albSecurityGroupId: string;

  @Column({ nullable: true, name: "app_security_group_id" })
  appSecurityGroupId: string;

  @Column({ nullable: true, name: "internal_security_group_id" })
  internalSecurityGroupId: string;

  @Column({ nullable: true, name: "cloud_map_namespace_id" })
  cloudMapNamespaceId: string;

  @Column({ nullable: true, name: "cloud_map_namespace_name" })
  cloudMapNamespaceName: string;

  @Column({ nullable: true, name: "cloud_map_service_discovery_domain" })
  cloudMapServiceDiscoveryDomain: string;

  @Column({ nullable: true, name: "terraform_workspace_path" })
  terraformWorkspacePath: string;

  @Column({ nullable: true, name: "terraform_state_key" })
  terraformStateKey: string;

  @Column({ nullable: true, name: "terraform_plan_summary", type: "jsonb" })
  terraformPlanSummary: Record<string, unknown> | null;

  @Column({ nullable: true, name: "terraform_outputs", type: "jsonb" })
  terraformOutputs: Record<string, unknown> | null;

  @Column({ nullable: true, name: "readiness_snapshot", type: "jsonb" })
  readinessSnapshot: Record<string, unknown> | null;

  @Column({ nullable: true, type: "jsonb" })
  metadata: Record<string, unknown> | null;

  @Column({ nullable: true, name: "error_message", type: "text" })
  errorMessage: string;

  @Column({ nullable: true, name: "provisioned_at", type: "timestamp" })
  provisionedAt: Date;

  @Column({ nullable: true, name: "failed_at", type: "timestamp" })
  failedAt: Date;

  @CreateDateColumn({ name: "created_at" })
  createdAt: Date;

  @UpdateDateColumn({ name: "updated_at" })
  updatedAt: Date;
}
