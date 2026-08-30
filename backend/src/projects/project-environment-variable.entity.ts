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
import { Project } from "./project.entity";
import { ConfigurationOwner } from "./configuration-ownership";
import { ProjectServiceBinding } from "./project-service-binding.entity";
import { ProjectDeployableService } from "./project-deployable-service.entity";

@Entity("project_environment_variables")
@Unique("UQ_project_environment_service_key", ["projectId", "serviceId", "normalizedKey"])
export class ProjectEnvironmentVariable {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Index()
  @Column({ name: "project_id" })
  projectId: string;

  @ManyToOne(() => Project, (project) => project.environmentVariables, {
    nullable: false,
    onDelete: "CASCADE",
  })
  @JoinColumn({ name: "project_id" })
  project: Project;

  @Index()
  @Column({ name: "service_id", type: "uuid" })
  serviceId: string;

  @ManyToOne(() => ProjectDeployableService, (service) => service.environmentVariables, { nullable: false, onDelete: "CASCADE" })
  @JoinColumn({ name: "service_id" })
  service: ProjectDeployableService;

  @Column()
  key: string;

  @Column({ name: "normalized_key" })
  normalizedKey: string;

  @Column({ select: false, type: "text" })
  value: string;

  @Column({ default: true, name: "is_secret" })
  isSecret: boolean;

  @Column({ default: "runtime" })
  scope: "build" | "runtime" | "both";

  @Column({ default: false, name: "is_required" })
  isRequired: boolean;

  @Column({ default: "dev" })
  environment: string;

  @Column({ nullable: true, name: "detected_source" })
  detectedSource: string | null;

  // `ConfigurationOwner` is a TypeScript union and has no runtime metadata.
  // Pin the persisted canonical owner to varchar so TypeORM does not infer
  // `Object` when the normal Nest data source starts.
  @Column({ type: "varchar", default: "user_optional" })
  owner: ConfigurationOwner;

  @Column({ default: "user" })
  source: string;

  @Column({ default: false })
  protected: boolean;

  @Column({ nullable: true, name: "service_binding_id" })
  serviceBindingId: string | null;

  @ManyToOne(() => ProjectServiceBinding, { nullable: true, onDelete: "SET NULL" })
  @JoinColumn({ name: "service_binding_id" })
  serviceBinding: ProjectServiceBinding | null;

  @Column({ nullable: true, name: "detected_reference" })
  detectedReference: string | null;

  @Column({ nullable: true, name: "repository_default" })
  repositoryDefault: string | null;

  @Column({ nullable: true, name: "superseded_by" })
  supersededBy: string | null;

  @Column({ nullable: true, name: "configuration_fingerprint" })
  configurationFingerprint: string | null;

  @Column({ default: true, name: "is_active" })
  isActive: boolean;

  @Column({ nullable: true, type: "timestamptz", name: "superseded_at" })
  supersededAt: Date | null;

  @Column({ nullable: true, name: "superseded_reason" })
  supersededReason: string | null;

  @Column({ nullable: true, type: "timestamptz", name: "applied_at" })
  appliedAt: Date | null;

  @Column({ default: 1, name: "encryption_version" })
  encryptionVersion: number;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt: Date;

  @UpdateDateColumn({ name: "updated_at", type: "timestamptz" })
  updatedAt: Date;
}
