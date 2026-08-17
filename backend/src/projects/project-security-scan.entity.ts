import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from "typeorm";
import { User } from "../users/user.entity";
import { ProjectPipelineRun } from "./project-pipeline-run.entity";
import { Project } from "./project.entity";
import { ProjectSecurityFinding } from "./project-security-finding.entity";

export enum SecurityScanStatus {
  QUEUED = "queued",
  RUNNING = "running",
  COMPLETED = "completed",
  FAILED = "failed",
}

export enum SecurityPolicyDecision {
  ALLOWED = "allowed",
  BLOCKED = "blocked",
  REQUIRES_APPROVAL = "requires_approval",
  APPROVED_OVERRIDE = "approved_override",
}

@Entity("project_security_scans")
export class ProjectSecurityScan {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Index()
  @Column({ name: "project_id" })
  projectId: string;

  @ManyToOne(() => Project, { nullable: false, onDelete: "CASCADE" })
  @JoinColumn({ name: "project_id" })
  project: Project;

  @Index()
  @Column({ nullable: true, name: "pipeline_run_id" })
  pipelineRunId: string;

  @ManyToOne(() => ProjectPipelineRun, { nullable: true, onDelete: "SET NULL" })
  @JoinColumn({ name: "pipeline_run_id" })
  pipelineRun: ProjectPipelineRun;

  @Column({ name: "image_name" })
  imageName: string;

  @Column({ nullable: true, name: "image_tag" })
  imageTag: string;

  @Column({ nullable: true, name: "image_uri" })
  imageUri: string;

  @Column({ default: "trivy" })
  scanner: string;

  @Column({ nullable: true, name: "scanner_version" })
  scannerVersion: string;

  @Column({ name: "scan_status" })
  scanStatus: string;

  @Column({ nullable: true, name: "started_at", type: "timestamptz" })
  startedAt: Date;

  @Column({ nullable: true, name: "completed_at", type: "timestamptz" })
  completedAt: Date;

  @Column({ nullable: true, name: "failed_at", type: "timestamptz" })
  failedAt: Date;

  @Column({ default: 0, name: "total_vulnerabilities" })
  totalVulnerabilities: number;

  @Column({ default: 0, name: "critical_count" })
  criticalCount: number;

  @Column({ default: 0, name: "high_count" })
  highCount: number;

  @Column({ default: 0, name: "medium_count" })
  mediumCount: number;

  @Column({ default: 0, name: "low_count" })
  lowCount: number;

  @Column({ default: 0, name: "unknown_count" })
  unknownCount: number;

  @Column({ nullable: true, name: "policy_decision" })
  policyDecision: string;

  @Column({ nullable: true, name: "policy_reason", type: "text" })
  policyReason: string;

  @Column({ default: false, name: "manual_approval_required" })
  manualApprovalRequired: boolean;

  @Column({ nullable: true, name: "approved_by_user_id" })
  approvedByUserId: number;

  @ManyToOne(() => User, { nullable: true, onDelete: "SET NULL" })
  @JoinColumn({ name: "approved_by_user_id" })
  approvedByUser: User;

  @Column({ nullable: true, name: "approved_at", type: "timestamptz" })
  approvedAt: Date;

  @Column({ nullable: true, name: "approval_reason", type: "text" })
  approvalReason: string;

  @Column({ nullable: true, name: "raw_summary", type: "jsonb" })
  rawSummary: Record<string, unknown> | null;

  @OneToMany(() => ProjectSecurityFinding, (finding) => finding.scan)
  findings: ProjectSecurityFinding[];

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt: Date;

  @UpdateDateColumn({ name: "updated_at", type: "timestamptz" })
  updatedAt: Date;
}
