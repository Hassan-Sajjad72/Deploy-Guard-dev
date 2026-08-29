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
import { Project } from "../projects/project.entity";
import { ProjectInfrastructureEnvironment } from "./project-infrastructure-environment.entity";

@Entity("project_service_discovery_records")
export class ProjectServiceDiscoveryRecord {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Index()
  @Column({ name: "project_id" })
  projectId: string;

  @ManyToOne(() => Project, { nullable: false, onDelete: "CASCADE" })
  @JoinColumn({ name: "project_id" })
  project: Project;

  @Column({ name: "infrastructure_environment_id" })
  infrastructureEnvironmentId: string;

  @ManyToOne(() => ProjectInfrastructureEnvironment, { nullable: false, onDelete: "CASCADE" })
  @JoinColumn({ name: "infrastructure_environment_id" })
  infrastructureEnvironment: ProjectInfrastructureEnvironment;

  @Column({ name: "service_name" })
  serviceName: string;

  @Column({ name: "namespace_id" })
  namespaceId: string;

  @Column({ name: "namespace_name" })
  namespaceName: string;

  @Column({ name: "dns_name" })
  dnsName: string;

  @Column({ nullable: true, name: "cloud_map_service_id" })
  cloudMapServiceId: string;

  @Column({ default: "ready" })
  status: string;

  @Column({ nullable: true, type: "jsonb" })
  metadata: Record<string, unknown> | null;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt: Date;

  @UpdateDateColumn({ name: "updated_at", type: "timestamptz" })
  updatedAt: Date;
}
