import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { DataSource } from "typeorm";
import { randomUUID } from "crypto";
import { AuthService } from "../auth/auth.service";
import { AuditLogService } from "../audit-log/audit-log.service";
import { User, UserRole } from "../users/user.entity";
import { assertInternalAdminScope, INTERNAL_ADMIN_ROLES, InternalAdminRole } from "./internal-admin-scope";

@Injectable()
export class AdminAuthorizationService {
  constructor(private readonly data: DataSource, private readonly auth: AuthService, private readonly audit: AuditLogService) {}

  async verifyIdentity(user: User, password: string) {
    if (user.role !== UserRole.ADMIN || user.githubId || !user.email) throw new ForbiddenException("Internal administrator required");
    const verified = await this.auth.adminLogin({ email: user.email, password });
    if (verified.id !== user.id) throw new ForbiddenException("Identity mismatch");
    const [row] = await this.data.query(`INSERT INTO admin_identity_verifications(user_id,expires_at) VALUES ($1,NOW()+interval '15 minutes') ON CONFLICT(user_id) DO UPDATE SET expires_at=EXCLUDED.expires_at RETURNING expires_at AS "expiresAt"`, [user.id]);
    await this.audit.record({ actorUser: user, action: "ADMIN_IDENTITY_VERIFIED", resourceType: "user", resourceId: String(user.id), status: "success" });
    return row;
  }

  async requireRecentVerification(user: User) {
    const [valid] = await this.data.query(`SELECT user_id FROM admin_identity_verifications WHERE user_id=$1 AND expires_at>NOW()`, [user.id]);
    if (!valid) throw new ForbiddenException("Confirm your administrator password before this sensitive action");
  }

  async updateAccount(actor: User, userId: number, input: { reason: string; disabled?: boolean; internalAdminRole?: InternalAdminRole }) {
    assertInternalAdminScope(actor, "super_admin");
    await this.requireRecentVerification(actor);
    const reason = this.reason(input.reason);
    if (input.internalAdminRole && !INTERNAL_ADMIN_ROLES.includes(input.internalAdminRole)) throw new BadRequestException("Invalid internal administrator role");
    const changed = await this.data.transaction(async (manager) => {
      await manager.query(`SELECT pg_advisory_xact_lock(hashtext('deployguard-internal-administrators'))`);
      const target = await manager.getRepository(User).findOne({ where: { id: userId } });
      if (!target) throw new NotFoundException("User not found");
      if (input.internalAdminRole && (target.role !== UserRole.ADMIN || target.githubId)) throw new BadRequestException("Internal roles require a separate administrator account");
      if (actor.id === target.id && (input.disabled === true || (input.internalAdminRole && input.internalAdminRole !== "super_admin"))) throw new BadRequestException("Cannot remove your own privileged access");
      if (target.internalAdminRole === "super_admin" && (input.disabled === true || (input.internalAdminRole && input.internalAdminRole !== "super_admin"))) {
        const [{ count }] = await manager.query(`SELECT COUNT(*)::int AS count FROM users WHERE internal_admin_role='super_admin' AND disabled_at IS NULL`);
        if (count <= 1) throw new BadRequestException("The last active super administrator must remain available");
      }
      if (input.disabled !== undefined) target.disabledAt = input.disabled ? new Date() : null;
      if (input.internalAdminRole) target.internalAdminRole = input.internalAdminRole;
      await manager.save(target);
      return { id: target.id, disabled: Boolean(target.disabledAt), internalAdminRole: target.internalAdminRole };
    });
    await this.audit.record({ actorUser: actor, action: "ADMIN_ACCOUNT_CONTROL_CHANGED", resourceType: "user", resourceId: String(userId), status: "success", metadata: { reason, ...changed } });
    return { user: changed };
  }

  async grantSupport(actor: User, organizationId: string, input: { operatorUserId: number; projectId?: string; purpose: string; durationMinutes: number }) {
    if (actor.role === UserRole.READONLY) throw new ForbiddenException("Owner approval required");
    const purpose = this.reason(input.purpose);
    if (!Number.isInteger(input.durationMinutes) || input.durationMinutes < 5 || input.durationMinutes > 1440) throw new BadRequestException("Support access must last 5 minutes to 24 hours");
    const grant = await this.data.transaction(async (manager) => {
      const [owner] = await manager.query(`SELECT user_id FROM organization_memberships WHERE organization_id=$1 AND user_id=$2 AND role='owner'`, [organizationId, actor.id]);
      if (!owner) throw new ForbiddenException("An organization owner must authorize support access");
      const [operator] = await manager.query(`SELECT id FROM users WHERE id=$1 AND role='admin' AND github_id IS NULL AND disabled_at IS NULL AND internal_admin_role IN ('support','platform_ops','super_admin')`, [input.operatorUserId]);
      if (!operator) throw new BadRequestException("An active support or platform operator is required");
      if (input.projectId) {
        const [project] = await manager.query(`SELECT id FROM projects WHERE id=$1 AND organization_id=$2 AND status<>'archived'`, [input.projectId, organizationId]);
        if (!project) throw new NotFoundException("Project not found");
      }
      const [created] = await manager.query(`INSERT INTO support_access_grants(id,organization_id,project_id,operator_user_id,approved_by_user_id,purpose,expires_at) VALUES ($1,$2,$3,$4,$5,$6,NOW()+($7*interval '1 minute')) RETURNING *`, [randomUUID(), organizationId, input.projectId || null, input.operatorUserId, actor.id, purpose, input.durationMinutes]);
      return created;
    });
    await this.audit.record({ actorUser: actor, action: "SUPPORT_ACCESS_APPROVED", resourceType: "organization", resourceId: organizationId, status: "success", metadata: { organizationId, grantId: grant.id, purpose, operatorUserId: input.operatorUserId, expiresAt: grant.expires_at } });
    return { grant };
  }

  async listSupport(actor: User, organizationId?: string) {
    if (organizationId) {
      const [member] = await this.data.query(`SELECT user_id FROM organization_memberships WHERE organization_id=$1 AND user_id=$2 AND role IN ('owner','admin')`, [organizationId, actor.id]);
      if (!member) throw new NotFoundException("Organization not found");
      return { grants: await this.data.query(`SELECT * FROM support_access_grants WHERE organization_id=$1 ORDER BY created_at DESC LIMIT 100`, [organizationId]) };
    }
    if (actor.role !== UserRole.ADMIN || !["support","platform_ops","super_admin"].includes(actor.internalAdminRole || "")) throw new ForbiddenException("Support operator scope required");
    return { grants: await this.data.query(`SELECT * FROM support_access_grants WHERE operator_user_id=$1 ORDER BY created_at DESC LIMIT 100`, [actor.id]) };
  }

  async revokeSupport(actor: User, organizationId: string, id: string) {
    const [owner] = await this.data.query(`SELECT user_id FROM organization_memberships WHERE organization_id=$1 AND user_id=$2 AND role='owner'`, [organizationId, actor.id]);
    if (!owner || actor.role === UserRole.READONLY) throw new ForbiddenException("Owner authorization required");
    const [[grant]] = await this.data.query(`UPDATE support_access_grants SET revoked_at=COALESCE(revoked_at,NOW()) WHERE id=$1 AND organization_id=$2 RETURNING id`, [id, organizationId]);
    if (!grant) throw new NotFoundException("Grant not found");
    await this.audit.record({ actorUser: actor, action: "SUPPORT_ACCESS_REVOKED", resourceType: "organization", resourceId: organizationId, status: "success", metadata: { organizationId, grantId: id } });
    return { revoked: true };
  }

  async supportProject(actor: User, grantId: string, projectId: string) {
    if (actor.role !== UserRole.ADMIN || !["support","platform_ops","super_admin"].includes(actor.internalAdminRole || "")) throw new ForbiddenException("Support operator scope required");
    await this.requireRecentVerification(actor);
    const [grant] = await this.data.query(`SELECT grant.* FROM support_access_grants grant JOIN projects project ON project.organization_id=grant.organization_id AND project.id=$3 JOIN organization_memberships owner ON owner.organization_id=grant.organization_id AND owner.user_id=grant.approved_by_user_id AND owner.role='owner' WHERE grant.id=$1 AND grant.operator_user_id=$2 AND (grant.project_id IS NULL OR grant.project_id=project.id) AND grant.expires_at>NOW() AND grant.revoked_at IS NULL AND project.status<>'archived'`, [grantId, actor.id, projectId]);
    if (!grant) throw new NotFoundException("Active authorized support grant not found");
    await this.audit.record({ actorUser: actor, action: "SUPPORT_PROJECT_EVIDENCE_VIEWED", resourceType: "organization", resourceId: grant.organization_id, status: "success", metadata: { organizationId: grant.organization_id, projectId, grantId, purpose: grant.purpose } });
    return { ...actor, role: UserRole.READONLY, organizationMemberships: [{ organizationId: grant.organization_id, role: "viewer" }] } as User;
  }

  private reason(value: string) { if (typeof value !== "string" || !value.trim() || value.length > 1000) throw new BadRequestException("A reason of 1 to 1000 characters is required"); return value.trim(); }
}
