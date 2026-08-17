import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from "typeorm";

@Entity("cloud_inventory_scans")
export class CloudInventoryScan {
  @PrimaryGeneratedColumn("uuid") id: string;
  @Index() @Column() scope: string;
  @Index() @Column({ name: "project_id", nullable: true, type: "uuid" }) projectId: string | null;
  @Column() region: string;
  @Column() status: string;
  @Column({ name: "resource_count", default: 0 }) resourceCount: number;
  @Column({ name: "services_checked", type: "jsonb", default: [] }) servicesChecked: string[];
  @Column({ type: "jsonb", default: [] }) errors: string[];
  @Column({ name: "started_at", type: "timestamptz" }) startedAt: Date;
  @Column({ name: "completed_at", type: "timestamptz" }) completedAt: Date;
  @CreateDateColumn({ name: "created_at", type: "timestamptz" }) createdAt: Date;
}
