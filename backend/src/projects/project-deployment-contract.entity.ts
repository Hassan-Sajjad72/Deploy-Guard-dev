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
import { ManagedDatabaseEngine } from "./managed-database-engine";

export type DeploymentContractLanguage = "javascript" | "python";
export type DeploymentRuntimeType = "static" | "server";
export type DeploymentDockerStrategy = "generated" | "custom";

export type DeploymentEnvironmentMapping = {
  name: string;
  source: "project" | "platform";
};

export type DeploymentSecretMapping = {
  name: string;
  source: "project_secret" | "platform_secret";
};

export type DeploymentDatabasePlan = {
  required: boolean;
  provider: "managed" | "external" | "none" | null;
  engine: ManagedDatabaseEngine | null;
  host: string | null;
  port: number | null;
  databaseName: string | null;
  databaseUser: string | null;
  image: string | null;
  dataPath: string | null;
  healthCheck: string[] | null;
  initializationEnvironment: Array<{ name: string; valueSource: "databaseName" | "databaseUser" }>;
  initializationSecretNames: string[];
  urlScheme: "postgresql" | "mysql" | "mongodb" | null;
  urlQuery: string;
  persistenceEnabled: boolean;
};

export type DeploymentEcsPlan = {
  containerPort: number | null;
  targetGroupPort: number | null;
  healthCheckPath: string;
  command: string | null;
  cpu: number;
  memory: number;
  environmentMappings: DeploymentEnvironmentMapping[];
  secretMappings: DeploymentSecretMapping[];
  logGroups: {
    app: string;
    database: string;
    deployment: string;
  };
  database: DeploymentDatabasePlan;
};

@Entity("project_deployment_contracts")
@Unique(["projectId"])
export class ProjectDeploymentContract {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Index()
  @Column({ name: "project_id" })
  projectId: string;

  @ManyToOne(() => Project, { nullable: false, onDelete: "CASCADE" })
  @JoinColumn({ name: "project_id" })
  project: Project;

  @Column({ nullable: true, name: "detection_profile_id" })
  detectionProfileId: string | null;

  @ManyToOne(() => ProjectDetectionProfile, { nullable: true, onDelete: "SET NULL" })
  @JoinColumn({ name: "detection_profile_id" })
  detectionProfile: ProjectDetectionProfile | null;

  @Column({ nullable: true, name: "repository_full_name" })
  repositoryFullName: string | null;

  @Column()
  branch: string;

  @Column({ nullable: true, name: "commit_sha" })
  commitSha: string | null;

  @Column({ default: ".", name: "app_root" })
  appRoot: string;

  @Column({ nullable: true })
  language: DeploymentContractLanguage | null;

  @Column({ nullable: true })
  framework: string | null;

  @Column({ nullable: true, name: "runtime_type" })
  runtimeType: DeploymentRuntimeType | null;

  @Column({ nullable: true, name: "package_manager" })
  packageManager: string | null;

  @Column({ nullable: true, name: "dependency_manifest" })
  dependencyManifest: string | null;

  @Column({ nullable: true })
  lockfile: string | null;

  @Column({ nullable: true, name: "node_version" })
  nodeVersion: string | null;

  @Column({ nullable: true, name: "python_version" })
  pythonVersion: string | null;

  @Column({ nullable: true, name: "install_command" })
  installCommand: string | null;

  @Column({ nullable: true, name: "build_command" })
  buildCommand: string | null;

  @Column({ nullable: true, name: "start_command" })
  startCommand: string | null;

  @Column({ nullable: true, name: "output_directory" })
  outputDirectory: string | null;

  @Column({ nullable: true, type: "integer" })
  port: number | null;

  @Column({ nullable: true, name: "port_source" })
  portSource: string | null;

  @Column({ default: false, name: "binds_to_port_env" })
  bindsToPortEnv: boolean;

  @Column({ nullable: true, name: "bind_host" })
  bindHost: string | null;

  @Column({ default: "/", name: "health_path" })
  healthPath: string;

  @Column({ type: "jsonb", default: [], name: "required_env_vars" })
  requiredEnvVars: string[];

  @Column({ type: "jsonb", default: [], name: "optional_env_vars" })
  optionalEnvVars: string[];

  @Column({ type: "jsonb", default: [], name: "build_time_env_vars" })
  buildTimeEnvVars: string[];

  @Column({ type: "jsonb", default: [], name: "runtime_env_vars" })
  runtimeEnvVars: string[];

  @Column({ type: "jsonb", default: [], name: "secret_env_vars" })
  secretEnvVars: string[];

  @Column({ type: "jsonb", default: [], name: "missing_env_vars" })
  missingEnvVars: string[];

  @Column({ default: false, name: "database_required" })
  databaseRequired: boolean;

  @Column({ nullable: true, name: "database_engine" })
  databaseEngine: ManagedDatabaseEngine | null;

  @Column({ default: false, name: "persistent_storage_required" })
  persistentStorageRequired: boolean;

  @Column({ default: false, name: "private_registry_required" })
  privateRegistryRequired: boolean;

  @Column({ nullable: true, name: "docker_strategy" })
  dockerStrategy: DeploymentDockerStrategy | null;

  @Column({ nullable: true, name: "docker_template" })
  dockerTemplate: string | null;

  @Column({ type: "jsonb", name: "ecs_plan" })
  ecsPlan: DeploymentEcsPlan;

  @Column({ default: false })
  deployable: boolean;

  @Column({ type: "jsonb", default: [] })
  blockers: string[];

  @Column({ type: "jsonb", default: [] })
  warnings: string[];

  @Column({ default: "low" })
  confidence: string;

  @Column({ type: "timestamptz", name: "generated_at" })
  generatedAt: Date;

  @Column({ nullable: true, name: "detection_source_commit" })
  detectionSourceCommit: string | null;

  @Column({ name: "overrides_hash" })
  overridesHash: string;

  @Column({ name: "contract_hash" })
  contractHash: string;

  @Column({ type: "jsonb", name: "build_plan" })
  /** Historical JSON retained only for migration compatibility; never executed. */
  buildPlan: Record<string, unknown>;

  @Column({ nullable: true, type: "text", name: "generated_dockerfile" })
  generatedDockerfile: string | null;

  @Column({ nullable: true, name: "invalidated_reason" })
  invalidatedReason: string | null;

  @Column({ nullable: true, type: "timestamptz", name: "invalidated_at" })
  invalidatedAt: Date | null;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt: Date;

  @UpdateDateColumn({ name: "updated_at", type: "timestamptz" })
  updatedAt: Date;
}
