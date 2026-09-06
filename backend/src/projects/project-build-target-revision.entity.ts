import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn, Unique } from "typeorm";
import { Project } from "./project.entity";
import { ProjectDeployableService } from "./project-deployable-service.entity";
import { ProjectPipelineRun } from "./project-pipeline-run.entity";

/** Exact-SHA, operation-scoped build topology evidence. It is never mutated after admission. */
@Entity("project_build_target_revisions")
@Unique("UQ_build_target_operation_service", ["operationId", "serviceId"])
export class ProjectBuildTargetRevision {
  @PrimaryGeneratedColumn("uuid") id: string;
  @Index() @Column({ name: "project_id", type: "uuid" }) projectId: string;
  @ManyToOne(() => Project, { nullable: false, onDelete: "CASCADE" }) @JoinColumn({ name: "project_id" }) project: Project;
  @Index() @Column({ name: "operation_id", type: "uuid" }) operationId: string;
  @ManyToOne(() => ProjectPipelineRun, { nullable: false, onDelete: "CASCADE" }) @JoinColumn({ name: "operation_id" }) operation: ProjectPipelineRun;
  @Index() @Column({ name: "service_id", type: "uuid" }) serviceId: string;
  @ManyToOne(() => ProjectDeployableService, { nullable: false, onDelete: "RESTRICT" }) @JoinColumn({ name: "service_id" }) service: ProjectDeployableService;
  @Column({ name: "source_sha", length: 40 }) sourceSha: string;
  @Column({ name: "resolver_version", length: 80 }) resolverVersion: string;
  @Index() @Column({ length: 64 }) fingerprint: string;
  @Column({ name: "target", type: "jsonb" }) target: Record<string, unknown>;
  @CreateDateColumn({ name: "created_at", type: "timestamptz" }) createdAt: Date;
}
