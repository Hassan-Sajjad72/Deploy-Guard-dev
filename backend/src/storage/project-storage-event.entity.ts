import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from "typeorm";
import { User } from "../users/user.entity";
import { ProjectPersistentStorage } from "./project-persistent-storage.entity";

@Entity("project_storage_events")
export class ProjectStorageEvent {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Index()
  @Column({ name: "project_id", type: "uuid" })
  projectId: string;

  @Column({ nullable: true, name: "pipeline_run_id", type: "uuid" })
  pipelineRunId: string;

  @Column({ nullable: true, name: "persistent_storage_id" })
  persistentStorageId: string;

  @ManyToOne(() => ProjectPersistentStorage, { nullable: true, onDelete: "SET NULL" })
  @JoinColumn({ name: "persistent_storage_id" })
  persistentStorage: ProjectPersistentStorage;

  @Column({ name: "event_type" })
  eventType: string;

  @Column()
  status: string;

  @Column({ type: "text" })
  message: string;

  @Column({ nullable: true, type: "jsonb" })
  metadata: Record<string, unknown> | null;

  @Column({ nullable: true, name: "actor_user_id" })
  actorUserId: number;

  @ManyToOne(() => User, { nullable: true, onDelete: "SET NULL" })
  @JoinColumn({ name: "actor_user_id" })
  actorUser: User;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt: Date;
}
