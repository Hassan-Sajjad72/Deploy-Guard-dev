import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from "typeorm";
@Entity("infrastructure_destroy_operations")
export class DestroyOperation {
  @PrimaryGeneratedColumn("uuid") id: string;
  @Index() @Column({ name: "project_id" }) projectId: string;
  @Index() @Column({ name: "user_id" }) userId: number;
  @Column({ name: "infrastructure_environment_id" }) infrastructureEnvironmentId: string;
  @Column({ name: "environment_name" }) environmentName: string;
  @Column({ default: "manual" }) source: string;
  @Index() @Column({ name: "emergency_operation_id", nullable: true }) emergencyOperationId: string | null;
  @Column({ default: "queued" }) status: string;
  @Column({ name: "queue_job_id", nullable: true }) queueJobId: string | null;
  @Column({ name: "state_backup_reference", nullable: true }) stateBackupReference: string | null;
  @Column({ name: "preserved_resources", type: "jsonb", nullable: true }) preservedResources: string[] | null;
  @Column({ name: "destroyed_resources", type: "jsonb", nullable: true }) destroyedResources: string[] | null;
  @Column({ name: "delete_persistent_database_data", default: false }) deletePersistentDatabaseData: boolean;
  @Column({ name: "resource_inventory", type: "jsonb", nullable: true }) resourceInventory: Record<string, unknown> | null;
  @Column({ name: "cleanup_status", default: "not_started" }) cleanupStatus: string;
  @Column({ name: "cleanup_result", type: "jsonb", nullable: true }) cleanupResult: Record<string, unknown> | null;
  @Column({ name: "cleanup_requested_at", type: "timestamptz", nullable: true }) cleanupRequestedAt: Date | null;
  @Column({ name: "cleanup_completed_at", type: "timestamptz", nullable: true }) cleanupCompletedAt: Date | null;
  @Column({ name: "error_message", type: "text", nullable: true }) errorMessage: string | null;
  @Column({ name: "started_at", type: "timestamptz", nullable: true }) startedAt: Date | null;
  @Column({ name: "completed_at", type: "timestamptz", nullable: true }) completedAt: Date | null;
  @CreateDateColumn({ name: "created_at", type: "timestamptz" }) createdAt: Date;
  @UpdateDateColumn({ name: "updated_at", type: "timestamptz" }) updatedAt: Date;
}
