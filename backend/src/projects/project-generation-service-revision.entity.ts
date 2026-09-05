import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn, Unique } from "typeorm";
import { Project } from "./project.entity";
import { ProjectDeployableService } from "./project-deployable-service.entity";
import { ProjectDeploymentGeneration } from "./project-deployment-generation.entity";
import { ProjectServiceRuntimeConfigRevision } from "./project-service-runtime-config-revision.entity";
import { ProjectBuildTargetRevision } from "./project-build-target-revision.entity";

/** Canonical immutable member of a project generation. */
@Entity("project_generation_service_revisions")
@Unique("UQ_generation_service_revision", ["generationId", "serviceId"])
export class ProjectGenerationServiceRevision {
  @PrimaryGeneratedColumn("uuid") id: string;
  @Index() @Column({ name: "project_id", type: "uuid" }) projectId: string;
  @ManyToOne(() => Project, { nullable: false, onDelete: "CASCADE" })
  @JoinColumn({ name: "project_id" }) project: Project;
  @Index() @Column({ name: "generation_id", type: "uuid" }) generationId: string;
  @ManyToOne(() => ProjectDeploymentGeneration, { nullable: false, onDelete: "CASCADE" })
  @JoinColumn({ name: "generation_id" }) generation: ProjectDeploymentGeneration;
  @Index() @Column({ name: "service_id", type: "uuid" }) serviceId: string;
  @ManyToOne(() => ProjectDeployableService, { nullable: false, onDelete: "CASCADE" })
  @JoinColumn({ name: "service_id" }) service: ProjectDeployableService;
  @Column({ name: "service_name", length: 80 }) serviceName: string;
  @Column({ name: "service_directory", length: 512 }) serviceDirectory: string;
  @Column({ name: "source_sha", length: 40 }) sourceSha: string;
  @Column({ name: "image_uri" }) imageUri: string;
  @Column({ name: "image_digest", length: 71 }) imageDigest: string;
  @Index() @Column({ name: "runtime_config_revision_id", type: "uuid" }) runtimeConfigRevisionId: string;
  @ManyToOne(() => ProjectServiceRuntimeConfigRevision, { nullable: false, onDelete: "RESTRICT" })
  @JoinColumn({ name: "runtime_config_revision_id" }) runtimeConfigRevision: ProjectServiceRuntimeConfigRevision;
  @Column({ name: "runtime_identity", type: "jsonb" }) runtimeIdentity: Record<string, unknown>;
  @Index() @Column({ name: "build_target_revision_id", type: "uuid", nullable: true }) buildTargetRevisionId: string | null;
  @ManyToOne(() => ProjectBuildTargetRevision, { nullable: true, onDelete: "RESTRICT" }) @JoinColumn({ name: "build_target_revision_id" }) buildTargetRevision: ProjectBuildTargetRevision | null;
  @CreateDateColumn({ name: "created_at", type: "timestamptz" }) createdAt: Date;
}
