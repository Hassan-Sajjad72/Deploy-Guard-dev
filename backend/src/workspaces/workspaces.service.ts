import { BadRequestException, ForbiddenException, Injectable, NotFoundException, Optional } from "@nestjs/common";
import { DataSource, EntityManager } from "typeorm";
import { randomUUID } from "node:crypto";
import { User, UserRole } from "../users/user.entity";
import { AuditLogService } from "../audit-log/audit-log.service";
import { ensurePersonalWorkspace } from "./personal-workspace";
import { AgencyRecordNameDto, CreateEngagementDto, CreateWorkspaceDto, SetMembershipDto } from "./workspace.dto";
import { OrganizationLimitsService } from "../billing/organization-limits.service";

@Injectable()
export class WorkspacesService {
  constructor(private readonly database: DataSource, private readonly audit: AuditLogService, @Optional() private readonly limits?: OrganizationLimitsService) {}

  async portfolio(user: User, organizationId: string) {
    await this.assertAgency(user, organizationId);
    const [clients, engagements] = await Promise.all([
      this.database.query(`SELECT id, name, archived_at AS "archivedAt", archive_reason AS "archiveReason", created_at AS "createdAt" FROM agency_clients WHERE organization_id = $1 ORDER BY created_at`, [organizationId]),
      this.database.query(`SELECT id, client_id AS "clientId", name, aws_account_binding_id AS "awsAccountBindingId", authorized_by_user_id AS "authorizedByUserId", authorization_reference AS "authorizationReference", archived_at AS "archivedAt", archive_reason AS "archiveReason", created_at AS "createdAt" FROM agency_engagements WHERE organization_id = $1 ORDER BY created_at`, [organizationId]),
    ]);
    return { clients, engagements };
  }

  async createClient(user: User, organizationId: string, dto: AgencyRecordNameDto) {
    if (!dto.name.trim()) throw new BadRequestException("Client name is required.");
    const client = await this.database.transaction(async (manager) => {
      await this.assertAgency(user, organizationId, true, manager);
      if (this.limits) await this.limits.assertCapacity(manager, organizationId, "agencyClients");
      const [row] = await manager.query(`INSERT INTO agency_clients(organization_id, name) VALUES($1, $2) RETURNING id, name`, [organizationId, dto.name.trim()]);
      if (this.limits) await this.limits.recordUsage(manager, organizationId, "agencyClients", `agency-client-created:${row.id}`);
      await this.audit.record({ actorUser: user, action: "AGENCY_CLIENT_CREATED", resourceType: "agency_client", resourceId: row.id, status: "success", metadata: { organizationId } }, manager);
      return row;
    });
    return client;
  }

  async createEngagement(user: User, organizationId: string, clientId: string, dto: CreateEngagementDto) {
    if (!dto.name.trim() || !dto.authorizationReference.trim() || dto.clientAuthorizationConfirmed !== true) throw new BadRequestException("A named engagement and explicit client authorization reference are required.");
    const engagement = await this.database.transaction(async (manager) => {
      await this.assertAgency(user, organizationId, true, manager);
      const [client] = await manager.query(`SELECT id FROM agency_clients WHERE id = $1 AND organization_id = $2 AND archived_at IS NULL FOR SHARE`, [clientId, organizationId]);
      if (!client) throw new NotFoundException("Active agency client not found.");
      const [binding] = await manager.query(`SELECT id FROM aws_account_bindings WHERE id = $1 AND organization_id = $2 AND verification_status <> 'revoked' FOR SHARE`, [dto.awsAccountBindingId, organizationId]);
      if (!binding) throw new BadRequestException("An active AWS binding in the agency workspace is required.");
      const [row] = await manager.query(`INSERT INTO agency_engagements(organization_id, client_id, name, aws_account_binding_id, authorized_by_user_id, authorization_reference) VALUES($1, $2, $3, $4, $5, $6) RETURNING id, name, client_id AS "clientId", aws_account_binding_id AS "awsAccountBindingId"`, [organizationId, clientId, dto.name.trim(), dto.awsAccountBindingId, user.id, dto.authorizationReference.trim()]);
      await this.audit.record({ actorUser: user, action: "AGENCY_ENGAGEMENT_CREATED", resourceType: "agency_engagement", resourceId: row.id, status: "success", metadata: { organizationId, clientId, bindingId: dto.awsAccountBindingId, clientAuthorizationConfirmed: true } }, manager);
      return row;
    });
    return engagement;
  }

  async updateAgencyRecord(user: User, organizationId: string, id: string, kind: "client" | "engagement", change: { name: string } | { reason: string }) {
    const archive = "reason" in change;
    const value = (archive ? change.reason : change.name).trim();
    if (!value) throw new BadRequestException(archive ? "An archive reason is required." : "A name is required.");
    const table = kind === "client" ? "agency_clients" : "agency_engagements";
    await this.database.transaction(async (manager) => {
      await this.assertAgency(user, organizationId, true, manager);
      const [rows] = await manager.query(archive
        ? `UPDATE ${table} SET archived_at = now(), archive_reason = $3 WHERE id = $1 AND organization_id = $2 AND archived_at IS NULL RETURNING id`
        : `UPDATE ${table} SET name = $3 WHERE id = $1 AND organization_id = $2 AND archived_at IS NULL RETURNING id`, [id, organizationId, value]);
      if (!rows.length) throw new NotFoundException("Active agency record not found.");
      if (archive && kind === "client" && this.limits) await this.limits.recordUsage(manager, organizationId, "agencyClients", `agency-client-archived:${id}`, -1);
      await this.audit.record({ actorUser: user, action: archive ? "AGENCY_RECORD_ARCHIVED" : "AGENCY_RECORD_RENAMED", resourceType: `agency_${kind}`, resourceId: id, status: "success", metadata: { organizationId, ...(archive ? { reason: value } : {}) } }, manager);
    });
  }

  private async assertAgency(user: User, organizationId: string, manage = false, manager: EntityManager = this.database.manager) {
    const [organization] = await manager.query(`SELECT kind FROM organizations WHERE id = $1${manage ? " FOR UPDATE" : ""}`, [organizationId]);
    await this.assertMembership(user, organizationId, manage, manager);
    if (organization?.kind !== "agency") throw new BadRequestException("Client portfolios are available only in agency workspaces.");
  }

  async list(user: User) {
    await this.database.transaction((manager) => ensurePersonalWorkspace(manager, user));
    return this.database.query(`SELECT organization.id, organization.name, organization.kind, organization.archived_at AS "archivedAt", organization.archive_reason AS "archiveReason", membership.role
      FROM organizations organization JOIN organization_memberships membership ON membership.organization_id = organization.id
      WHERE membership.user_id = $1 ORDER BY organization.created_at`, [user.id]);
  }

  async create(user: User, dto: CreateWorkspaceDto) {
    if (user.role === UserRole.READONLY || !dto.name.trim()) throw new ForbiddenException("Workspace creation is not permitted.");
    const organization = await this.database.transaction(async (manager) => {
      const [row] = await manager.query(`INSERT INTO organizations (name, kind) VALUES ($1, $2) RETURNING id, name, kind`, [dto.name.trim(), dto.kind]);
      await manager.query(`INSERT INTO organization_memberships (organization_id, user_id, role) VALUES ($1, $2, 'owner')`, [row.id, user.id]);
      if (this.limits) await this.limits.recordUsage(manager, row.id, "members", `workspace-owner-created:${row.id}`);
      await this.audit.record({ actorUser: user, action: "WORKSPACE_CREATED", resourceType: "organization", resourceId: row.id, status: "success" }, manager);
      return row;
    });
    return organization;
  }

  async assertMembership(user: User, organizationId: string, manage = false, manager: EntityManager = this.database.manager) {
    const [membership] = await manager.query(`SELECT membership.role, organization.archived_at AS "archivedAt" FROM organization_memberships membership JOIN organizations organization ON organization.id = membership.organization_id WHERE membership.organization_id = $1 AND membership.user_id = $2`, [organizationId, user.id]);
    if (!membership || user.disabledAt || (manage && (user.role === UserRole.READONLY || !["owner", "admin"].includes(membership.role)))) throw new ForbiddenException("Workspace access required.");
    if (manage && membership.archivedAt) throw new ForbiddenException("Archived workspaces do not permit new administrative changes.");
    return membership;
  }

  async update(user: User, organizationId: string, change: { name: string } | { reason: string }) {
    const archive = "reason" in change;
    const value = (archive ? change.reason : change.name).trim();
    if (!value) throw new BadRequestException(archive ? "An archive reason is required." : "A workspace name is required.");
    await this.database.transaction(async (manager) => {
      await manager.query(`SELECT id FROM organizations WHERE id = $1 FOR UPDATE`, [organizationId]);
      const membership = await this.assertMembership(user, organizationId, true, manager);
      if (archive && membership.role !== "owner") throw new ForbiddenException("Only the workspace owner can archive this workspace.");
      await manager.query(archive
        ? `UPDATE organizations SET archived_at = now(), archive_reason = $2 WHERE id = $1`
        : `UPDATE organizations SET name = $2 WHERE id = $1`, [organizationId, value]);
      await this.audit.record({ actorUser: user, action: archive ? "WORKSPACE_ARCHIVED" : "WORKSPACE_RENAMED", resourceType: "organization", resourceId: organizationId, status: "success", metadata: { organizationId, ...(archive ? { reason: value } : { name: value }) } }, manager);
    });
    return { updated: true };
  }

  async members(user: User, organizationId: string) {
    await this.assertMembership(user, organizationId);
    return this.database.query(`SELECT membership.user_id AS "userId", membership.role, users.name, users.github_login AS "githubLogin"
      FROM organization_memberships membership JOIN users ON users.id = membership.user_id WHERE membership.organization_id = $1 ORDER BY users.id`, [organizationId]);
  }

  async setMember(user: User, organizationId: string, dto: SetMembershipDto) {
    await this.database.transaction(async (manager) => {
      const [organization] = await manager.query(`SELECT kind FROM organizations WHERE id = $1 FOR UPDATE`, [organizationId]);
      await this.assertMembership(user, organizationId, true, manager);
      if (!organization || organization.kind === "personal") throw new BadRequestException("Personal workspaces have one owner.");
      const [target] = await manager.query(`SELECT id FROM users WHERE id = $1 AND disabled_at IS NULL AND github_id IS NOT NULL`, [dto.userId]);
      if (!target) throw new NotFoundException("An enabled GitHub user is required.");
      const [current] = await manager.query(`SELECT role FROM organization_memberships WHERE organization_id = $1 AND user_id = $2`, [organizationId, dto.userId]);
      if (current?.role === "owner") throw new BadRequestException("Workspace ownership cannot be changed through membership updates.");
      if (!current && this.limits) await this.limits.assertCapacity(manager, organizationId, "members");
      await this.audit.record({ actorUser: user, action: "WORKSPACE_MEMBER_UPDATED", resourceType: "organization", resourceId: organizationId, status: "success", metadata: { memberUserId: dto.userId, role: dto.role } }, manager);
      await manager.query(`INSERT INTO organization_memberships (organization_id, user_id, role) VALUES ($1, $2, $3)
        ON CONFLICT (organization_id, user_id) DO UPDATE SET role = EXCLUDED.role`, [organizationId, dto.userId, dto.role]);
      if (!current && this.limits) await this.limits.recordUsage(manager, organizationId, "members", `workspace-member-added:${organizationId}:${dto.userId}:${randomUUID()}`);
    });
  }

  async removeMember(user: User, organizationId: string, userId: number) {
    await this.database.transaction(async (manager) => {
      await manager.query(`SELECT id FROM organizations WHERE id = $1 FOR UPDATE`, [organizationId]);
      await this.assertMembership(user, organizationId, true, manager);
      const [membership] = await manager.query(`SELECT role FROM organization_memberships WHERE organization_id = $1 AND user_id = $2`, [organizationId, userId]);
      if (!membership) throw new NotFoundException("Member not found.");
      if (membership.role === "owner") throw new BadRequestException("The workspace owner cannot be removed.");
      await manager.query(`DELETE FROM organization_memberships WHERE organization_id = $1 AND user_id = $2`, [organizationId, userId]);
      if (this.limits) await this.limits.recordUsage(manager, organizationId, "members", `workspace-member-removed:${organizationId}:${userId}:${randomUUID()}`, -1);
      await this.audit.record({ actorUser: user, action: "WORKSPACE_MEMBER_REMOVED", resourceType: "organization", resourceId: organizationId, status: "success", metadata: { memberUserId: userId } }, manager);
    });
  }
}
