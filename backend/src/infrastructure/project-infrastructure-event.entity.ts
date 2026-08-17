import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from "typeorm";
import { User } from "../users/user.entity";
import { ProjectInfrastructureEnvironment } from "./project-infrastructure-environment.entity";
import { ProjectPipelineRun } from "../projects/project-pipeline-run.entity";
import { Project } from "../projects/project.entity";

@Entity("project_infrastructure_events")
export class ProjectInfrastructureEvent {
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

  @Column({ name: "event_type" })
  eventType: string;

  @Column()
  status: string;

  @Column({ type: "text" })
  message: string;

  @Column({ nullable: true, type: "jsonb" })
  metadata: Record<string, unknown> | null;

  @Column({ name: "occurred_at", type: "timestamptz", default: () => "CURRENT_TIMESTAMP" })
  occurredAt: Date;

  @Column({ name: "ingested_at", type: "timestamptz", default: () => "CURRENT_TIMESTAMP" })
  ingestedAt: Date;

  @Column({ name: "duration_ms", type: "bigint", nullable: true })
  durationMs: number | null;

  @Column({ default: "terraform" })
  source: string;

  @Column({ name: "sequence_number", type: "integer", default: 0 })
  sequenceNumber: number;

  @Column({ nullable: true, name: "actor_user_id" })
  actorUserId: number;

  @ManyToOne(() => User, { nullable: true, onDelete: "SET NULL" })
  @JoinColumn({ name: "actor_user_id" })
  actorUser: User;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt: Date;
}
