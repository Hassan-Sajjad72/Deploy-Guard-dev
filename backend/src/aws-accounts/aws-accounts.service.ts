import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, ServiceUnavailableException, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { randomUUID } from "node:crypto";
import { DataSource, EntityManager, IsNull } from "typeorm";
import { AuditLog } from "../audit-log/audit-log.entity";
import { User, UserRole } from "../users/user.entity";
import { CreateOrganizationDto, RegisterAwsAccountDto } from "./aws-account.dto";
import { AwsAccountBinding } from "./aws-account-binding.entity";
import { Organization } from "./organization.entity";
import { OrganizationMembership } from "./organization-membership.entity";

@Injectable()
export class AwsAccountsService {
  constructor(private readonly dataSource: DataSource, private readonly config: ConfigService) {}

  private async actor(manager: EntityManager, actorId: number, write: boolean) {
    const user = await manager.findOne(User, { where: { id: actorId }, lock: { mode: "pessimistic_read" } });
    if (!user || user.disabledAt) throw new UnauthorizedException("Active authentication required");
    if (write && ![UserRole.ADMIN, UserRole.DEVELOPER].includes(user.role)) throw new ForbiddenException("Insufficient permissions");
    return user;
  }

  private async authorize(manager: EntityManager, actorId: number, organizationId: string, write: boolean) {
    const user = await this.actor(manager, actorId, write);
    const membership = await manager.findOne(OrganizationMembership, {
      where: { organizationId, userId: actorId, revokedAt: IsNull() }, lock: { mode: "pessimistic_read" },
    });
    // Platform roles, workspace visibility and knowing a UUID are not membership.
    if (!membership) throw new NotFoundException("Organization not found");
    if (write && !["OWNER", "ADMINISTRATOR"].includes(membership.role)) throw new ForbiddenException("Organization administration required");
    return user;
  }

  private async audit(manager: EntityManager, user: User, action: string, organizationId: string, binding?: AwsAccountBinding) {
    // Use the existing audit entity in the same transaction; an audit write must
    // not silently fail while the privileged registration/revocation commits.
    await manager.save(AuditLog, manager.create(AuditLog, {
      actorUserId: user.id, actorEmail: user.email, actorRole: user.role,
      action, category: "security", resourceType: binding ? "aws_account_binding" : "organization",
      resourceId: binding?.id || organizationId, status: "success",
      metadata: { organizationId, ...(binding ? { accountId: binding.accountId, region: binding.region, bindingStatus: binding.status } : {}) },
    }));
  }

  createOrganization(actorId: number, dto: CreateOrganizationDto) {
    return this.dataSource.transaction(async (manager) => {
      const user = await this.actor(manager, actorId, true);
      const name = dto.name?.trim();
      if (!name || name.length > 120 || !["TEAM", "AGENCY"].includes(dto.mode)) throw new BadRequestException("Invalid organization");
      const organization = await manager.save(Organization, manager.create(Organization, { name, mode: dto.mode }));
      await manager.save(OrganizationMembership, manager.create(OrganizationMembership, { organizationId: organization.id, userId: actorId, role: "OWNER", revokedAt: null }));
      await this.audit(manager, user, "organization_created", organization.id);
      return organization;
    });
  }

  listOrganizations(actorId: number) {
    return this.dataSource.transaction(async (manager) => {
      await this.actor(manager, actorId, false);
      return manager.createQueryBuilder(Organization, "organization")
        .innerJoin(OrganizationMembership, "membership", "membership.organization_id = organization.id")
        .where("membership.user_id = :actorId AND membership.revoked_at IS NULL", { actorId })
        .orderBy("organization.createdAt", "DESC").addOrderBy("organization.id", "ASC").take(100).getMany();
    });
  }

  register(actorId: number, organizationId: string, dto: RegisterAwsAccountDto) {
    return this.dataSource.transaction(async (manager) => {
      const user = await this.authorize(manager, actorId, organizationId, true);
      const controlAccount = this.config.get<string>("AWS_ACCOUNT_ID", "");
      if (!/^\d{12}$/.test(controlAccount)) throw new ServiceUnavailableException("Control-plane AWS account identity is not configured");
      if (!/^\d{12}$/.test(dto.accountId) || dto.accountId === controlAccount || dto.region !== "us-east-1"
        || typeof dto.roleArn !== "string" || dto.roleArn.length > 2048
        || !new RegExp(`^arn:aws:iam::${dto.accountId}:role/[A-Za-z0-9_+=,.@/-]+$`).test(dto.roleArn)) {
        throw new BadRequestException("A distinct customer account, matching role and us-east-1 region are required");
      }
      // Serialize duplicate registration within one tenant. Do not overwrite or
      // reactivate a revoked identity, or alter another tenant's binding.
      await manager.findOneOrFail(Organization, { where: { id: organizationId }, lock: { mode: "pessimistic_write" } });
      const existing = await manager.findOne(AwsAccountBinding, { where: { organizationId, accountId: dto.accountId, roleArn: dto.roleArn, region: dto.region } });
      if (existing) throw new ConflictException("This AWS binding is already registered; revoked records are retained");
      const binding = await manager.save(AwsAccountBinding, manager.create(AwsAccountBinding, {
        organizationId, accountId: dto.accountId, region: dto.region, roleArn: dto.roleArn,
        externalId: randomUUID(), status: "PENDING", revokedAt: null,
      }));
      await this.audit(manager, user, "aws_account_binding_registered", organizationId, binding);
      return binding;
    });
  }

  list(actorId: number, organizationId: string) {
    return this.dataSource.transaction(async (manager) => {
      await this.authorize(manager, actorId, organizationId, false);
      return manager.find(AwsAccountBinding, { where: { organizationId }, order: { createdAt: "DESC", id: "ASC" }, take: 100 });
    });
  }

  revoke(actorId: number, organizationId: string, bindingId: string) {
    return this.dataSource.transaction(async (manager) => {
      const user = await this.authorize(manager, actorId, organizationId, true);
      const binding = await manager.findOne(AwsAccountBinding, {
        where: { id: bindingId, organizationId }, lock: { mode: "pessimistic_write" },
      });
      if (!binding) throw new NotFoundException("AWS account binding not found");
      if (binding.status !== "REVOKED") {
        binding.status = "REVOKED"; binding.revokedAt = new Date();
        await manager.save(binding);
        await this.audit(manager, user, "aws_account_binding_revoked", organizationId, binding);
      }
      return binding;
    });
  }
}
