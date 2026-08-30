import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, OneToMany, PrimaryGeneratedColumn, Unique, UpdateDateColumn } from "typeorm";
import { Project } from "./project.entity";
import { ProjectEnvironmentVariable } from "./project-environment-variable.entity";

@Entity("project_deployable_services")
@Unique("UQ_project_deployable_service_name", ["projectId", "name"])
@Unique("UQ_project_deployable_service_position", ["projectId", "position"])
export class ProjectDeployableService {
  @PrimaryGeneratedColumn("uuid") id: string;
  @Index() @Column({ name: "project_id", type: "uuid" }) projectId: string;
  @ManyToOne(() => Project, (project) => project.services, { nullable: false, onDelete: "CASCADE" })
  @JoinColumn({ name: "project_id" }) project: Project;
  @Column({ length: 80 }) name: string;
  @Column({ name: "service_directory", length: 512, default: "." }) serviceDirectory: string;
  @Column({ type: "integer", default: 0 }) position: number;
  @OneToMany(() => ProjectEnvironmentVariable, (variable) => variable.service) environmentVariables: ProjectEnvironmentVariable[];
  @CreateDateColumn({ name: "created_at", type: "timestamptz" }) createdAt: Date;
  @UpdateDateColumn({ name: "updated_at", type: "timestamptz" }) updatedAt: Date;
}
