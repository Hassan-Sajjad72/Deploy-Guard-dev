import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from "typeorm";
import { Project } from "./project.entity";

@Entity("project_environment_variables")
@Unique(["projectId", "key"])
export class ProjectEnvironmentVariable {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Index()
  @Column({ name: "project_id" })
  projectId: string;

  @ManyToOne(() => Project, (project) => project.environmentVariables, {
    nullable: false,
    onDelete: "CASCADE",
  })
  @JoinColumn({ name: "project_id" })
  project: Project;

  @Column()
  key: string;

  @Column({ select: false, type: "text" })
  value: string;

  @Column({ default: true, name: "is_secret" })
  isSecret: boolean;

  @Column({ default: "runtime" })
  scope: "build" | "runtime" | "both";

  @Column({ default: false, name: "is_required" })
  isRequired: boolean;

  @Column({ default: "production" })
  environment: "production" | "development";

  @Column({ nullable: true, name: "detected_source" })
  detectedSource: string | null;

  @Column({ default: "user_supplied" })
  owner:
    | "user_supplied"
    | "platform_generated"
    | "platform_detected"
    | "external_service_supplied";

  @Column({ default: true, name: "is_active" })
  isActive: boolean;

  @Column({ nullable: true, type: "timestamptz", name: "superseded_at" })
  supersededAt: Date | null;

  @Column({ nullable: true, name: "superseded_reason" })
  supersededReason: string | null;

  @Column({ nullable: true, type: "timestamptz", name: "applied_at" })
  appliedAt: Date | null;

  @Column({ default: 1, name: "encryption_version" })
  encryptionVersion: number;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt: Date;

  @UpdateDateColumn({ name: "updated_at", type: "timestamptz" })
  updatedAt: Date;
}
