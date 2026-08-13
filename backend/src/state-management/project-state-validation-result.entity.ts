import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from "typeorm";

export enum StateValidationStatus {
  VALID = "valid",
  CORRUPTED = "corrupted",
  WARNING = "warning",
  FAILED = "failed",
}

@Entity("project_state_validation_results")
export class ProjectStateValidationResult {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Index()
  @Column({ name: "project_id", type: "uuid" })
  projectId: string;

  @Column({
    nullable: true,
    name: "infrastructure_environment_id",
    type: "uuid",
  })
  infrastructureEnvironmentId: string;

  @Column({ default: "dev", name: "environment_name" })
  environmentName: string;

  @Column({ nullable: true, name: "state_version_id" })
  stateVersionId: string;

  @Column()
  status: string;

  @Column({ name: "json_schema_valid" })
  jsonSchemaValid: boolean;

  @Column({ name: "checksum_valid" })
  checksumValid: boolean;

  @Column({ name: "resource_count_valid" })
  resourceCountValid: boolean;

  @Column({ name: "dependency_graph_valid" })
  dependencyGraphValid: boolean;

  @Column({ nullable: true, name: "resource_count" })
  resourceCount: number;

  @Column({ nullable: true, name: "expected_checksum" })
  expectedChecksum: string;

  @Column({ nullable: true, name: "actual_checksum" })
  actualChecksum: string;

  @Column({ nullable: true, type: "jsonb" })
  issues: string[] | null;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt: Date;
}
