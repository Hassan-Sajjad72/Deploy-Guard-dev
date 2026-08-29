import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn, Unique, UpdateDateColumn } from "typeorm";
import { User } from "../users/user.entity";
import { Project } from "./project.entity";

@Entity("project_user_activity")
@Unique(["userId", "projectId"])
export class ProjectUserActivity {
  @PrimaryGeneratedColumn("uuid") id: string;

  @Index()
  @Column({ name: "user_id" })
  userId: number;

  @ManyToOne(() => User, { nullable: false, onDelete: "CASCADE" })
  @JoinColumn({ name: "user_id" })
  user: User;

  @Index()
  @Column({ name: "project_id" })
  projectId: string;

  @ManyToOne(() => Project, { nullable: false, onDelete: "CASCADE" })
  @JoinColumn({ name: "project_id" })
  project: Project;

  @Column({ nullable: true, name: "last_viewed_at", type: "timestamptz" }) lastViewedAt: Date | null;
  @Column({ nullable: true, name: "last_user_action_at", type: "timestamptz" }) lastUserActionAt: Date | null;
  @Column({ nullable: true, name: "last_meaningful_activity_at", type: "timestamptz" }) lastMeaningfulActivityAt: Date | null;
  @Column({ nullable: true, name: "last_pipeline_activity_at", type: "timestamptz" }) lastPipelineActivityAt: Date | null;
  @Column({ nullable: true, name: "last_route" }) lastRoute: string | null;
  @Column({ nullable: true, name: "last_section" }) lastSection: string | null;
  @Column({ nullable: true, name: "last_action_type" }) lastActionType: string | null;
  @Column({ default: false }) pinned: boolean;
  @UpdateDateColumn({ name: "updated_at", type: "timestamptz" }) updatedAt: Date;
}
