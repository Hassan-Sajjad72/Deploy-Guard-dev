import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from "typeorm";
import { ProjectPipelineRun } from "./project-pipeline-run.entity";
import { ProjectSecurityScan } from "./project-security-scan.entity";
import { Project } from "./project.entity";

export enum SecurityFindingSeverity {
  CRITICAL = "CRITICAL",
  HIGH = "HIGH",
  MEDIUM = "MEDIUM",
  LOW = "LOW",
  UNKNOWN = "UNKNOWN",
}

@Entity("project_security_findings")
export class ProjectSecurityFinding {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Index()
  @Column({ name: "scan_id" })
  scanId: string;

  @ManyToOne(() => ProjectSecurityScan, (scan) => scan.findings, {
    nullable: false,
    onDelete: "CASCADE",
  })
  @JoinColumn({ name: "scan_id" })
  scan: ProjectSecurityScan;

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

  @Index()
  @Column({ name: "vulnerability_id" })
  vulnerabilityId: string;

  @Column()
  severity: string;

  @Column({ nullable: true, name: "package_name" })
  packageName: string;

  @Column({ nullable: true, name: "installed_version" })
  installedVersion: string;

  @Column({ nullable: true, name: "fixed_version" })
  fixedVersion: string;

  @Column({ nullable: true })
  target: string;

  @Column({ nullable: true })
  type: string;

  @Column({ nullable: true, type: "text" })
  title: string;

  @Column({ nullable: true, type: "text" })
  description: string;

  @Column({ nullable: true, name: "primary_url", type: "text" })
  primaryUrl: string;

  @Column({ nullable: true, type: "text" })
  remediation: string;

  @Index()
  @Column({ default: "unknown" })
  origin: string;

  @Index()
  @Column({ default: "unknown" })
  fixability: string;

  @Index()
  @Column({ default: "warning", name: "policy_action" })
  policyAction: string;

  @CreateDateColumn({ name: "created_at" })
  createdAt: Date;
}
