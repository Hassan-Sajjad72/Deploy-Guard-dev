import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { DataSource, EntityManager } from "typeorm";
import { randomUUID } from "crypto";
import { User } from "../users/user.entity";
import { AdminAuthorizationService } from "../admin/admin-authorization.service";
import { assertInternalAdminScope } from "../admin/internal-admin-scope";
import { AuditLogService } from "../audit-log/audit-log.service";
import { planFingerprint } from "../planning/deployment-plan";
import { OrganizationEntitlementVersion, OrganizationLimits } from "./organization-limits.entity";
import { PublishOrganizationLimitsDto } from "./organization-limits.dto";
export type CapacityResource = "members" | "projects" | "environments" | "agencyClients";
const EMPTY_LIMITS: OrganizationLimits = { members: null, projects: null, environments: null, agencyClients: null, evidenceRetentionDays: null, aiRequestsPerDay: null, aiBudgetUsdPerDay: null };

@Injectable()
export class OrganizationLimitsService {
  constructor(private readonly db: DataSource, private readonly authorization: AdminAuthorizationService, private readonly audit: AuditLogService, private readonly config: ConfigService) {}
  async lock(manager: EntityManager, organizationId: string) { await manager.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`organization-entitlements:${organizationId}`]); }
  async effective(organizationId: string | undefined | null, manager: EntityManager = this.db.manager) {
    if (!organizationId) return { version: null, limits: { ...EMPTY_LIMITS } };
    const version = await manager.getRepository(OrganizationEntitlementVersion).findOne({ where: { organizationId }, order: { version: "DESC" } });
    return { version, limits: version?.limits || { ...EMPTY_LIMITS } };
  }
  async count(manager: EntityManager, organizationId: string, resource: CapacityResource): Promise<number> {
    const queries = {
      members: `SELECT count(*)::integer AS count FROM organization_memberships WHERE organization_id=$1`,
      projects: `SELECT count(*)::integer AS count FROM projects WHERE organization_id=$1 AND status<>'archived' AND archived_at IS NULL`,
      environments: `SELECT count(*)::integer AS count FROM (SELECT id,environment_name FROM projects WHERE organization_id=$1 AND status<>'archived' AND archived_at IS NULL UNION SELECT project.id,route.environment_name FROM project_environment_routes route JOIN projects project ON project.id=route.project_id WHERE project.organization_id=$1 AND project.status<>'archived' AND project.archived_at IS NULL) environments`,
      agencyClients: `SELECT count(*)::integer AS count FROM agency_clients WHERE organization_id=$1 AND archived_at IS NULL`,
    };
    const [row] = await manager.query(queries[resource], [organizationId]); return row.count;
  }
  async counts(manager: EntityManager, organizationId: string) {
    const resources: CapacityResource[] = ["members","projects","environments","agencyClients"];
    return Object.fromEntries(await Promise.all(resources.map(async (resource) => [resource, await this.count(manager,organizationId,resource)]))) as Record<CapacityResource,number>;
  }
  async assertCapacity(manager: EntityManager, organizationId: string, resource: CapacityResource, increment = 1) {
    if (!["members","projects","environments","agencyClients"].includes(resource) || !Number.isSafeInteger(increment) || increment < 0 || increment > 100000) throw new BadRequestException("Invalid capacity request.");
    await this.lock(manager, organizationId);
    const effective = await this.effective(organizationId, manager); const used = await this.count(manager, organizationId, resource); const limit = effective.limits[resource];
    if (increment > 0 && limit !== null && used + increment > limit) throw new ForbiddenException({ code: "ORGANIZATION_ENTITLEMENT_LIMIT", resource, limit, used, version: effective.version!.version, message: `Workspace ${resource} capacity reached. Existing records are retained; a reviewed entitlement change is required for new capacity.` });
    return { allowed: true, resource, used, limit, enforcement: limit === null ? "unconfigured" : "enforced", version: effective.version?.version || null };
  }
  async recordUsage(manager: EntityManager, organizationId: string, resource: CapacityResource, idempotencyKey: string, quantity = 1) {
    if (!["members","projects","environments","agencyClients"].includes(resource) || typeof idempotencyKey !== "string" || !idempotencyKey.trim() || idempotencyKey.length > 200 || !Number.isSafeInteger(quantity) || quantity === 0 || Math.abs(quantity) > 100000) throw new BadRequestException("A valid immutable metering event is required.");
    await this.lock(manager, organizationId); const effective = await this.effective(organizationId, manager);
    const rows = await manager.query(`INSERT INTO organization_entitlement_usage_events(id,organization_id,entitlement_version_id,resource,quantity,idempotency_key) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(idempotency_key) DO NOTHING RETURNING id`, [randomUUID(), organizationId, effective.version?.id || null, resource, quantity, idempotencyKey]);
    if (!rows.length) { const [previous] = await manager.query(`SELECT organization_id,resource,quantity FROM organization_entitlement_usage_events WHERE idempotency_key=$1`, [idempotencyKey]); if (!previous || previous.organization_id !== organizationId || previous.resource !== resource || previous.quantity !== quantity) throw new ConflictException("Metering identity belongs to another scope or quantity."); }
    return { recorded: !!rows.length, idempotent: !rows.length };
  }
  async view(actor: User, organizationId: string, internal = false) {
    if (internal) assertInternalAdminScope(actor, "billing");
    else { const [member] = await this.db.query(`SELECT membership.user_id FROM organization_memberships membership JOIN users actor ON actor.id=membership.user_id WHERE membership.organization_id=$1 AND membership.user_id=$2 AND membership.role IN ('owner','admin') AND actor.disabled_at IS NULL`, [organizationId, actor.id]); if (!member) throw new NotFoundException("Workspace not found."); }
    const [organization] = await this.db.query(`SELECT id,name,kind,archived_at FROM organizations WHERE id=$1`, [organizationId]); if (!organization) throw new NotFoundException("Workspace not found.");
    const [aiUsage] = await this.db.query(`WITH period AS (SELECT (now() AT TIME ZONE 'UTC')::date AS day)
      SELECT period.day::text AS day, COALESCE(usage.request_count,0)::integer AS "requests", COALESCE(usage.committed_usd_micros,0)::text AS "trackedAndReservedUsdMicros",
      (SELECT count(*)::integer FROM organization_ai_requests request JOIN organization_ai_settlements settlement ON settlement.request_id=request.id WHERE request.organization_id=$1 AND request.usage_day=period.day) AS "settledRequests"
      FROM period LEFT JOIN organization_ai_daily_usage usage ON usage.organization_id=$1 AND usage.usage_day=period.day`, [organizationId]);
    const trackedAndReservedUsd=Number(aiUsage.trackedAndReservedUsdMicros)/1000000;
    return { organization, ...(await this.effective(organizationId)), usage: { ...(await this.counts(this.db.manager, organizationId)), aiRequestsPerDay:aiUsage.requests, aiBudgetUsdPerDay:trackedAndReservedUsd },
      aiUsage:{day:aiUsage.day,requests:aiUsage.requests,trackedAndReservedUsd,settledRequests:aiUsage.settledRequests,unsettledRequests:Math.max(0,aiUsage.requests-aiUsage.settledRequests)}, minimumEvidenceRetentionDays: 90,
      limitDisclosure: "Unconfigured limits are not a promise of unlimited capacity. Existing subscription project limits and default AI safety budgets remain applicable.",
      history: await this.db.getRepository(OrganizationEntitlementVersion).find({ where: { organizationId }, order: { version: "DESC" }, take: 50 }),
      meteringEvents: await this.db.query(`SELECT id,resource,quantity,entitlement_version_id,created_at FROM organization_entitlement_usage_events WHERE organization_id=$1 ORDER BY created_at DESC LIMIT 100`, [organizationId]) };
  }
  async publish(actor: User, organizationId: string, input: PublishOrganizationLimitsDto) {
    assertInternalAdminScope(actor, "billing"); await this.authorization.requireRecentVerification(actor);
    if (!input.reason.trim() || !input.limits || typeof input.limits !== "object") throw new BadRequestException("Explicit limits and a change reason are required.");
    const limits = { ...EMPTY_LIMITS, ...input.limits } as OrganizationLimits;
    for (const [key, value] of Object.entries(limits)) {
      if (!(key in EMPTY_LIMITS) || (value !== null && (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100000 || (key !== "aiBudgetUsdPerDay" && !Number.isInteger(value))))) throw new BadRequestException("Invalid entitlement limit.");
    }
    if (limits.evidenceRetentionDays !== null && limits.evidenceRetentionDays < 90) throw new BadRequestException("Operational evidence retention cannot be shorter than 90 days.");
    if ([limits.members,limits.projects,limits.environments,limits.aiRequestsPerDay].some((value) => value !== null && value < 1) || limits.evidenceRetentionDays !== null && limits.evidenceRetentionDays > 3650 || limits.aiRequestsPerDay !== null && limits.aiRequestsPerDay > 10000 || limits.aiBudgetUsdPerDay !== null && (limits.aiBudgetUsdPerDay > 1000 || Math.abs(Math.round(limits.aiBudgetUsdPerDay * 100) - limits.aiBudgetUsdPerDay * 100) > 1e-8)) throw new BadRequestException("Entitlements exceed supported bounds.");
    const hardRequests = Number(this.config.get("AI_HARD_ORGANIZATION_DAILY_REQUEST_LIMIT", "100")); const hardBudget = Number(this.config.get("AI_HARD_ORGANIZATION_DAILY_BUDGET_USD", "5"));
    if (limits.aiRequestsPerDay !== null && (!Number.isSafeInteger(hardRequests) || limits.aiRequestsPerDay > hardRequests) || limits.aiBudgetUsdPerDay !== null && (!Number.isFinite(hardBudget) || limits.aiBudgetUsdPerDay > hardBudget)) throw new BadRequestException("AI entitlements exceed the configured server safety ceiling.");
    const fingerprint = planFingerprint({ contractVersion: 1, organizationId, tier: input.tier, limits, reason: input.reason.trim() });
    return this.db.transaction(async (manager) => {
      await this.lock(manager, organizationId); await this.authorization.requireRecentVerification(actor);
      const [operator] = await manager.query(`SELECT id FROM users WHERE id=$1 AND role='admin' AND github_id IS NULL AND disabled_at IS NULL AND internal_admin_role IN ('super_admin','billing')`, [actor.id]); if (!operator) throw new ForbiddenException("Current billing operator authority is required.");
      const [organization] = await manager.query(`SELECT id,kind,archived_at FROM organizations WHERE id=$1`, [organizationId]); if (!organization || organization.archived_at) throw new NotFoundException("Active workspace not found.");
      if (input.tier !== ({ personal: "startup", team: "team", agency: "agency" } as Record<string,string>)[organization.kind]) throw new BadRequestException("Entitlement tier must match the workspace mode.");
      const repo = manager.getRepository(OrganizationEntitlementVersion); const existing = await repo.findOneBy({ idempotencyKey: input.idempotencyKey });
      if (existing) { if (existing.fingerprint !== fingerprint || existing.organizationId !== organizationId) throw new ConflictException("Entitlement change identity was already used for a different scope or limits."); return { version: existing, idempotent: true }; }
      const current = await this.effective(organizationId, manager);
      const version = await repo.save({ id: randomUUID(), organizationId, version: (current.version?.version || 0) + 1, tier: input.tier, limits, reason: input.reason.trim(), actorUserId: actor.id, idempotencyKey: input.idempotencyKey, fingerprint });
      await this.audit.record({ actorUser: actor, action: "ORGANIZATION_ENTITLEMENTS_CHANGED", resourceType: "organization", resourceId: organizationId, status: "success", metadata: { organizationId, entitlementVersion: version.version, fingerprint, reason: input.reason.trim(), tier: input.tier } }, manager);
      return { version, idempotent: false };
    });
  }
}
