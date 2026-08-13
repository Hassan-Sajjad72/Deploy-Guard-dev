import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn, Unique, UpdateDateColumn } from "typeorm";
import { Project } from "../project.entity";
import { ProjectPipelineRun } from "../project-pipeline-run.entity";

export type StageCheckpointStatus = "passed" | "reused" | "invalidated";

@Entity("project_stage_checkpoints")
@Unique(["pipelineRunId", "stage"])
export class ProjectStageCheckpoint {
  @PrimaryGeneratedColumn("uuid") id: string;
  @Index() @Column({ name: "project_id" }) projectId: string;
  @ManyToOne(() => Project, { nullable: false, onDelete: "CASCADE" }) @JoinColumn({ name: "project_id" }) project: Project;
  @Index() @Column({ name: "pipeline_run_id" }) pipelineRunId: string;
  @ManyToOne(() => ProjectPipelineRun, { nullable: false, onDelete: "CASCADE" }) @JoinColumn({ name: "pipeline_run_id" }) pipelineRun: ProjectPipelineRun;
  @Index() @Column() stage: string;
  @Column() fingerprint: string;
  @Column({ default: "passed" }) status: StageCheckpointStatus;
  @Column({ nullable: true, name: "source_checkpoint_id", type: "uuid" }) sourceCheckpointId: string | null;
  @Column({ nullable: true, type: "jsonb", name: "artifact_reference" }) artifactReference: Record<string, unknown> | null;
  @Column({ nullable: true, name: "image_tag" }) imageTag: string | null;
  @Column({ nullable: true, name: "image_digest" }) imageDigest: string | null;
  @Column({ nullable: true, type: "jsonb", name: "terraform_metadata" }) terraformMetadata: Record<string, unknown> | null;
  @Column({ nullable: true, type: "jsonb" }) metadata: Record<string, unknown> | null;
  @CreateDateColumn({ name: "created_at", type: "timestamptz" }) createdAt: Date;
  @UpdateDateColumn({ name: "updated_at", type: "timestamptz" }) updatedAt: Date;
}
