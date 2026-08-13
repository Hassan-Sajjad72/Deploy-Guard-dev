import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn, Unique, UpdateDateColumn } from "typeorm";
import { Project } from "./project.entity";
import { ProjectDeploymentGeneration } from "./project-deployment-generation.entity";

@Entity("project_environment_routes")
@Unique("UQ_project_environment_route_scope", ["projectId", "environmentName"])
@Index("UQ_project_environment_route_priority", ["listenerPriority"], { unique: true })
export class ProjectEnvironmentRoute {
  @PrimaryGeneratedColumn("uuid") id: string;
  @Index() @Column({ name: "project_id", type: "uuid" }) projectId: string;
  @ManyToOne(() => Project, { nullable: false, onDelete: "CASCADE" })
  @JoinColumn({ name: "project_id" }) project: Project;
  @Column({ name: "environment_name", length: 64 }) environmentName: string;
  @Column({ name: "listener_priority", type: "integer" }) listenerPriority: number;
  @Column({ name: "listener_rule_arn", nullable: true }) listenerRuleArn: string | null;
  @Column({ name: "live_generation_id", nullable: true, type: "uuid" }) liveGenerationId: string | null;
  @ManyToOne(() => ProjectDeploymentGeneration, { nullable: true, onDelete: "SET NULL" })
  @JoinColumn({ name: "live_generation_id" }) liveGeneration: ProjectDeploymentGeneration | null;
  @Column({ name: "candidate_generation_id", nullable: true, type: "uuid" }) candidateGenerationId: string | null;
  @ManyToOne(() => ProjectDeploymentGeneration, { nullable: true, onDelete: "SET NULL" })
  @JoinColumn({ name: "candidate_generation_id" }) candidateGeneration: ProjectDeploymentGeneration | null;
  @Column({ type: "jsonb", default: {} }) metadata: Record<string, unknown>;
  @CreateDateColumn({ name: "created_at", type: "timestamptz" }) createdAt: Date;
  @UpdateDateColumn({ name: "updated_at", type: "timestamptz" }) updatedAt: Date;
}
