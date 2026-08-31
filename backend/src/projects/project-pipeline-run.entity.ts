import {
  Column,
  Check,
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
import { Project } from "./project.entity";
import { ProjectPipelineEvent } from "./project-pipeline-event.entity";
import { ProjectServiceBinding } from "./project-service-binding.entity";
import { ProjectConfigurationSnapshot } from "./project-configuration-snapshot.entity";
import { ExternalProvider, FailureOwner } from "./failure-ownership";

export enum PipelineRunStatus {
  QUEUED = "queued",
  RUNNING = "running",
  COST_ANALYSIS_RUNNING = "cost_analysis_running",
  WAITING_FOR_COST_APPROVAL = "waiting_for_cost_approval",
  BLOCKED_BY_COST_LIMIT = "blocked_by_cost_limit",
  COST_REJECTED = "cost_rejected",
  COST_ANALYSIS_FAILED = "cost_analysis_failed",
  STATE_LOCK_ACQUIRING = "state_lock_acquiring",
  WAITING_FOR_STATE_LOCK = "waiting_for_state_lock",
  STATE_LOCK_ACQUIRED = "state_lock_acquired",
  STATE_HEARTBEAT_ACTIVE = "state_heartbeat_active",
  STATE_VALIDATION_RUNNING = "state_validation_running",
  STATE_RECOVERY_REQUIRED = "state_recovery_required",
  STATE_LOCK_RELEASED = "state_lock_released",
  STATE_LOCK_FAILED = "state_lock_failed",
  STORAGE_EVALUATION_RUNNING = "storage_evaluation_running",
  STORAGE_NOT_REQUIRED = "storage_not_required",
  STORAGE_PROVISIONING = "storage_provisioning",
  STORAGE_PROVISIONED = "storage_provisioned",
  STORAGE_FAILED = "storage_failed",
  BACKUP_CONFIGURING = "backup_configuring",
  BACKUP_CONFIGURED = "backup_configured",
  BACKUP_FAILED = "backup_failed",
  ECS_DEPLOYMENT_QUEUED = "ecs_deployment_queued",
  ECS_TASK_DEFINITION_REGISTERING = "ecs_task_definition_registering",
  ECS_SERVICE_UPDATING = "ecs_service_updating",
  ECS_WAITING_FOR_STABILITY = "ecs_waiting_for_stability",
  ECS_SERVICE_HEALTHY = "ecs_service_healthy",
  ECS_SERVICE_UNHEALTHY = "ecs_service_unhealthy",
  ECS_DEPLOYMENT_FAILED = "ecs_deployment_failed",
  ROLLBACK_STARTED = "rollback_started",
  ROLLBACK_SUCCEEDED = "rollback_succeeded",
  ROLLBACK_FAILED = "rollback_failed",
  SPOT_INTERRUPTION_HANDLED = "spot_interruption_handled",
  APPLY_DISABLED = "apply_disabled",
  COMPLETED = "completed",
  FAILED = "failed",
  CANCELLED = "cancelled",
}

@Entity("project_pipeline_runs")
@Check(
  "CHK_project_pipeline_runs_execution_lane",
  `"execution_lane" IS NULL OR "execution_lane" IN ('release','infrastructure','deletion')`,
)
@Check(
  "CHK_project_pipeline_runs_fencing_token",
  `"operation_fencing_token" IS NULL OR "operation_fencing_token" > 0`,
)
@Check(
  "CHK_project_pipeline_runs_worker_protocol",
  `"worker_protocol_version" IS NULL OR "worker_protocol_version" > 0`,
)
export class ProjectPipelineRun {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Index("IDX_pipeline_runs_deployment_intent")
  @Column({ name: "project_id" })
  projectId: string;

  @ManyToOne(() => Project, { nullable: false, onDelete: "CASCADE" })
  @JoinColumn({ name: "project_id" })
  project: Project;

  @Index("IDX_pipeline_runs_generation")
  @Column({ nullable: true, name: "generation_id", type: "uuid" })
  generationId: string | null;

  @Index("IDX_pipeline_runs_execution_lane")
  @Column({ name: "triggered_by_user_id" })
  triggeredByUserId: number;

  @ManyToOne(() => User, { nullable: false, onDelete: "CASCADE" })
  @JoinColumn({ name: "triggered_by_user_id" })
  triggeredByUser: User;

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

  @Column({ nullable: true, name: "database_service_binding_id" })
  databaseServiceBindingId: string | null;

  @ManyToOne(() => ProjectServiceBinding, { nullable: true, onDelete: "SET NULL" })
  @JoinColumn({ name: "database_service_binding_id" })
  databaseServiceBinding: ProjectServiceBinding | null;

  @Column({ nullable: true, name: "configuration_snapshot_id" })
  configurationSnapshotId: string | null;

  @ManyToOne(() => ProjectConfigurationSnapshot, { nullable: true, onDelete: "SET NULL" })
  @JoinColumn({ name: "configuration_snapshot_id" })
  configurationSnapshot: ProjectConfigurationSnapshot | null;

  @Index("IDX_pipeline_runs_infrastructure_manifest")
  @Column({ nullable: true, name: "deployment_intent_id", type: "uuid" })
  deploymentIntentId: string | null;

  @Index("IDX_pipeline_runs_release_manifest")
  @Column({ nullable: true, name: "execution_lane", length: 24 })
  executionLane: "release" | "infrastructure" | "deletion" | null;

  @Index()
  @Column({ nullable: true, name: "infrastructure_manifest_id", type: "uuid" })
  infrastructureManifestId: string | null;

  @Index()
  @Column({ nullable: true, name: "release_manifest_id", type: "uuid" })
  releaseManifestId: string | null;

  @Column({ nullable: true, name: "worker_protocol_version", type: "integer" })
  workerProtocolVersion: number | null;

  @Column({ nullable: true, name: "operation_fencing_token", type: "bigint" })
  operationFencingToken: string | null;

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

  @Column({ nullable: true, name: "started_at", type: "timestamptz" })
  startedAt: Date;

  @Column({ nullable: true, name: "current_stage_started_at", type: "timestamptz" })
  currentStageStartedAt: Date | null;

  @Column({ nullable: true, name: "completed_at", type: "timestamptz" })
  completedAt: Date;

  @Column({ nullable: true, name: "failed_at", type: "timestamptz" })
  failedAt: Date;

  @Column({ nullable: true, name: "error_message", type: "text" })
  errorMessage: string;

  @Column({ nullable: true, name: "failure_owner", type: "varchar", length: 40 }) failureOwner: FailureOwner | null;
  @Column({ nullable: true, name: "external_provider", type: "varchar", length: 24 }) externalProvider: ExternalProvider | null;
  @Column({ nullable: true, name: "failure_code", type: "varchar", length: 80 }) failureCode: string | null;
  @Column({ nullable: true, name: "failure_service_id", type: "uuid" }) failureServiceId: string | null;

  @Column({ nullable: true, type: "jsonb" })
  metadata: Record<string, unknown> | null;

  @OneToMany(() => ProjectPipelineEvent, (event) => event.pipelineRun)
  events: ProjectPipelineEvent[];

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt: Date;

  @UpdateDateColumn({ name: "updated_at", type: "timestamptz" })
  updatedAt: Date;
}
