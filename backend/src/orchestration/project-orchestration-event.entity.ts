import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from "typeorm";
import { User } from "../users/user.entity";
import { ProjectDeployment } from "./project-deployment.entity";

@Entity("project_orchestration_events")
export class ProjectOrchestrationEvent {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Index()
  @Column({ name: "project_id", type: "uuid" })
  projectId: string;

  @Column({ nullable: true, name: "pipeline_run_id", type: "uuid" })
  pipelineRunId: string;

  @Column({ nullable: true, name: "deployment_id" })
  deploymentId: string;

  @ManyToOne(() => ProjectDeployment, { nullable: true, onDelete: "SET NULL" })
  @JoinColumn({ name: "deployment_id" })
  deployment: ProjectDeployment;

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

  @Column({ default: "aws_ecs" })
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
