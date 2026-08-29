import { Check, Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from "typeorm";
@Entity("infrastructure_destroy_operations")
@Check(
  "CHK_destroy_operations_fencing_token",
  `"operation_fencing_token" IS NULL OR "operation_fencing_token" > 0`,
)
export class DestroyOperation {
  @PrimaryGeneratedColumn("uuid") id: string;
  @Index() @Column({ name: "project_id", type: "uuid" }) projectId: string;
  @Index() @Column({ name: "user_id" }) userId: number;
  @Column({ name: "infrastructure_environment_id", type: "uuid" }) infrastructureEnvironmentId: string;
  @Column({ name: "environment_name" }) environmentName: string;
  @Column({ default: "manual" }) source: string;
  @Index() @Column({ name: "emergency_operation_id", nullable: true, type: "uuid" }) emergencyOperationId: string | null;
  @Column({ default: "queued" }) status: string;
  @Column({ name: "queue_job_id", nullable: true }) queueJobId: string | null;
  @Index("IDX_destroy_operations_deployment_intent") @Column({ name: "deployment_intent_id", type: "uuid", nullable: true }) deploymentIntentId: string | null;
  @Index("IDX_destroy_operations_infrastructure_manifest") @Column({ name: "infrastructure_manifest_id", type: "uuid", nullable: true }) infrastructureManifestId: string | null;
  @Column({ name: "operation_fencing_token", type: "bigint", nullable: true }) operationFencingToken: string | null;
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
