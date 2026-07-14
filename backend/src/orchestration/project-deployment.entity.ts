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
import { ProjectInfrastructureEnvironment } from "../infrastructure/project-infrastructure-environment.entity";
import { ProjectPipelineRun } from "../projects/project-pipeline-run.entity";
import { Project } from "../projects/project.entity";

export enum ProjectDeploymentStatus {
  QUEUED = "queued",
  DEPLOYING = "deploying",
  WAITING_FOR_SERVICE_STABILITY = "waiting_for_service_stability",
  HEALTHY = "healthy",
  UNHEALTHY = "unhealthy",
  FAILED = "failed",
  ROLLBACK_STARTED = "rollback_started",
  ROLLBACK_SUCCEEDED = "rollback_succeeded",
  ROLLBACK_FAILED = "rollback_failed",
  INTERRUPTED = "interrupted",
  SCALED = "scaled",
}

@Entity("project_deployments")
export class ProjectDeployment {
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

  @Column({ nullable: true, name: "infrastructure_environment_id" })
  infrastructureEnvironmentId: string;

  @ManyToOne(() => ProjectInfrastructureEnvironment, { nullable: true, onDelete: "SET NULL" })
  @JoinColumn({ name: "infrastructure_environment_id" })
  infrastructureEnvironment: ProjectInfrastructureEnvironment;

  @Column({ default: "dev", name: "environment_name" })
  environmentName: string;

  @Column({ default: ProjectDeploymentStatus.QUEUED })
  status: string;

  @Column({ nullable: true, name: "commit_sha" })
  commitSha: string;

  @Column({ nullable: true, name: "short_commit_sha" })
  shortCommitSha: string;

  @Column({ nullable: true, name: "image_uri" })
  imageUri: string;

  @Column({ nullable: true, name: "task_definition_arn" })
  taskDefinitionArn: string;

  @Column({ nullable: true, name: "previous_task_definition_arn" })
  previousTaskDefinitionArn: string;

  @Column({ nullable: true, name: "ecs_cluster_arn" })
  ecsClusterArn: string;

  @Column({ nullable: true, name: "ecs_cluster_name" })
  ecsClusterName: string;

  @Column({ nullable: true, name: "ecs_service_arn" })
  ecsServiceArn: string;

  @Column({ nullable: true, name: "ecs_service_name" })
  ecsServiceName: string;

  @Column({ nullable: true, name: "alb_arn" })
  albArn: string;

  @Column({ nullable: true, name: "alb_dns_name" })
  albDnsName: string;

  @Column({ nullable: true, name: "target_group_arn" })
  targetGroupArn: string;

  @Column({ nullable: true, name: "listener_arn" })
  listenerArn: string;

  @Column({ default: "/health", name: "health_check_path" })
  healthCheckPath: string;

  @Column({ nullable: true, name: "app_port" })
  appPort: number;

  @Column({ default: 1, name: "desired_count" })
  desiredCount: number;

  @Column({ default: 1, name: "min_tasks" })
  minTasks: number;

  @Column({ default: 3, name: "max_tasks" })
  maxTasks: number;

  @Column({ default: 60, name: "cpu_target_percent" })
  cpuTargetPercent: number;

  @Column({ nullable: true, name: "capacity_provider_strategy", type: "jsonb" })
  capacityProviderStrategy: Record<string, unknown>[] | null;

  @Column({ nullable: true, name: "efs_mount_config", type: "jsonb" })
  efsMountConfig: Record<string, unknown> | null;

  @Column({ nullable: true, name: "cloud_map_namespace_id" })
  cloudMapNamespaceId: string;

  @Column({ nullable: true, name: "cloud_map_service_name" })
  cloudMapServiceName: string;

  @Column({ nullable: true, name: "deployment_started_at", type: "timestamp" })
  deploymentStartedAt: Date;

  @Column({ nullable: true, name: "deployment_completed_at", type: "timestamp" })
  deploymentCompletedAt: Date;

  @Column({ nullable: true, name: "failed_at", type: "timestamp" })
  failedAt: Date;

  @Column({ nullable: true, name: "rollback_started_at", type: "timestamp" })
  rollbackStartedAt: Date;

  @Column({ nullable: true, name: "rollback_completed_at", type: "timestamp" })
  rollbackCompletedAt: Date;

  @Column({ default: false })
  stable: boolean;

  @Column({ nullable: true, type: "jsonb" })
  metadata: Record<string, unknown> | null;

  @Column({ nullable: true, name: "error_message", type: "text" })
  errorMessage: string;

  @CreateDateColumn({ name: "created_at" })
  createdAt: Date;

  @UpdateDateColumn({ name: "updated_at" })
  updatedAt: Date;
}
