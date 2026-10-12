import { Column, CreateDateColumn, Entity, Index, PrimaryColumn } from "typeorm";
export type OrganizationLimits = { members: number | null; projects: number | null; environments: number | null; agencyClients: number | null; evidenceRetentionDays: number | null; aiRequestsPerDay: number | null; aiBudgetUsdPerDay: number | null };
@Entity("organization_entitlement_versions")
@Index(["organizationId", "version"], { unique: true })
export class OrganizationEntitlementVersion {
  @PrimaryColumn("uuid") id: string;
  @Column({ name: "organization_id", type: "uuid" }) organizationId: string;
  @Column({ type: "integer" }) version: number;
  @Column() tier: "startup" | "team" | "agency";
  @Column({ type: "jsonb" }) limits: OrganizationLimits;
  @Column({ length: 1000 }) reason: string;
  @Column({ name: "actor_user_id", type: "integer" }) actorUserId: number;
  @Column({ name: "idempotency_key", type: "uuid", unique: true }) idempotencyKey: string;
  @Column({ length: 64 }) fingerprint: string;
  @CreateDateColumn({ name: "created_at", type: "timestamptz" }) createdAt: Date;
}
