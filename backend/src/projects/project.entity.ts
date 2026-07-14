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
import { ProjectEnvironmentVariable } from "./project-environment-variable.entity";

export enum ProjectStatus {
  CREATED = "created",
  CONFIGURED = "configured",
  ARCHIVED = "archived",
}

export enum ProjectVisibility {
  PRIVATE = "private",
  WORKSPACE = "workspace",
}

@Entity("projects")
export class Project {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Index()
  @Column({ name: "owner_user_id" })
  ownerUserId: number;

  @ManyToOne(() => User, { nullable: false, onDelete: "CASCADE" })
  @JoinColumn({ name: "owner_user_id" })
  owner: User;

  @Column()
  name: string;

  @Column({ nullable: true })
  description: string;

  @Column({ name: "repository_url" })
  repositoryUrl: string;

  @Column({ default: "github", name: "repository_provider" })
  repositoryProvider: string;

  @Index()
  @Column({ nullable: true, name: "repository_full_name" })
  repositoryFullName: string;

  @Column({ default: "main", name: "target_branch" })
  targetBranch: string;

  @Column({ nullable: true, name: "app_directory" })
  appDirectory: string;

  @Column({
    type: "enum",
    enum: ProjectStatus,
    default: ProjectStatus.CREATED,
  })
  status: ProjectStatus;

  @Column({
    type: "enum",
    enum: ProjectVisibility,
    default: ProjectVisibility.PRIVATE,
  })
  visibility: ProjectVisibility;

  @OneToMany(() => ProjectEnvironmentVariable, (variable) => variable.project)
  environmentVariables: ProjectEnvironmentVariable[];

  @CreateDateColumn({ name: "created_at" })
  createdAt: Date;

  @UpdateDateColumn({ name: "updated_at" })
  updatedAt: Date;

  @Column({ nullable: true, name: "archived_at", type: "timestamp" })
  archivedAt: Date;
}
