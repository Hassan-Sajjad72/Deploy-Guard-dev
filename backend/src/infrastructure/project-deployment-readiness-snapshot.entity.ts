import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from "typeorm";
import { ProjectPipelineRun } from "../projects/project-pipeline-run.entity";
import { Project } from "../projects/project.entity";
import { User } from "../users/user.entity";

@Entity("project_deployment_readiness_snapshots")
export class ProjectDeploymentReadinessSnapshot {
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

  @Column()
  ready: boolean;

  @Column({ type: "jsonb" })
  checks: Record<string, unknown>[];

  @Column({ name: "blocking_reasons", type: "jsonb" })
  blockingReasons: string[];

  @Column({ nullable: true, name: "created_by_user_id" })
  createdByUserId: number;

  @ManyToOne(() => User, { nullable: true, onDelete: "SET NULL" })
  @JoinColumn({ name: "created_by_user_id" })
  createdByUser: User;

  @CreateDateColumn({ name: "created_at" })
  createdAt: Date;
}
