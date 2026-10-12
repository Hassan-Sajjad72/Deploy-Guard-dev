import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { DataSource } from "typeorm";
import { AdminAuthorizationService } from "../admin/admin-authorization.service";
import { assertInternalAdminScope } from "../admin/internal-admin-scope";
import { AuditLogService } from "../audit-log/audit-log.service";
import { User } from "../users/user.entity";
import { planFingerprint } from "../planning/deployment-plan";
import { HostingProfileRegistryService } from "../planning/hosting-profile-registry.service";
import { AwsAccountBinding } from "./aws-account-binding.entity";
import { validateCustomerAuthorityProof } from "./customer-authority-proof";
@Injectable()
export class CustomerAuthorityService {
  constructor(private readonly data: DataSource, private readonly config: ConfigService, private readonly authorization: AdminAuthorizationService, private readonly audit: AuditLogService, private readonly profiles: HostingProfileRegistryService) {}
  async import(actor: User, organizationId: string, bindingId: string, input: { proof: unknown; signature: string; reason: string }) {
    assertInternalAdminScope(actor, "platform_ops");
    await this.authorization.requireRecentVerification(actor);
    if (typeof input.reason !== "string" || !input.reason.trim() || input.reason.length > 1000) throw new BadRequestException("A final verification reason is required.");
    return this.data.transaction(async (manager) => {
      await manager.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`customer-authority:${bindingId}`]);
      const [operator] = await manager.query(`SELECT actor.id FROM users actor JOIN admin_identity_verifications verification ON verification.user_id = actor.id WHERE actor.id = $1 AND actor.role = 'admin' AND actor.github_id IS NULL AND actor.disabled_at IS NULL AND actor.internal_admin_role IN ('platform_ops','super_admin') AND verification.expires_at > now() FOR SHARE OF actor, verification`, [actor.id]);
      if (!operator) throw new ForbiddenException("Operator authority or recent identity verification changed.");
      const [organization] = await manager.query(`SELECT id FROM organizations WHERE id = $1 AND archived_at IS NULL FOR SHARE`, [organizationId]);
      if (!organization) throw new NotFoundException("Active workspace not found.");
      const repository = manager.getRepository(AwsAccountBinding);
      const binding = await repository.findOne({ where: { id: bindingId, organizationId }, lock: { mode: "pessimistic_write" } });
      if (!binding) throw new NotFoundException("AWS binding not found.");
      const envelope = { proof: input.proof, signature: input.signature };
      const proof = validateCustomerAuthorityProof(this.config, envelope, binding);
      if (!proof || proof.finalApproval.actorId !== String(actor.id)) throw new ConflictException("Signed final mutation proof does not match the operator, fresh binding version, account, regions or validity window.");
      if (proof.regions.some((region) => !this.profiles.available("ecs_fargate", region))) throw new ConflictException("Final profile evidence is unavailable for an authorized customer region.");
      const projects = await manager.query(`SELECT id FROM projects WHERE organization_id = $1 AND id = ANY($2::uuid[]) AND status <> 'archived' AND deletion_intent_id IS NULL FOR SHARE`, [organizationId, proof.projectIds]);
      if (projects.length !== proof.projectIds.length) throw new ConflictException("Final authority proof includes a foreign, archived or deleting project.");
      const fingerprint = planFingerprint(proof);
      if (binding.verificationEvidence?.authorityProofFingerprint === fingerprint) return { mutationAuthority: "verified", fingerprint, expiresAt: proof.expiresAt, alreadyImported: true };
      binding.verificationEvidence = { ...(binding.verificationEvidence || {}), mutationAuthority: "verified", crossAccountDeployment: "verified", authorityProof: envelope, authorityProofFingerprint: fingerprint, authorityVerifiedByUserId: actor.id, authorityImportedAt: new Date().toISOString() };
      await repository.save(binding);
      await this.audit.record({ actorUser: actor, action: "AWS_BINDING_FINAL_AUTHORITY_IMPORTED", resourceType: "aws_binding", resourceId: bindingId, status: "success", metadata: { organizationId, bindingVersion: binding.verificationVersion, accountId: binding.accountId, regions: proof.regions, projectIds: proof.projectIds, fingerprint, expiresAt: proof.expiresAt, approvalId: proof.finalApproval.approvalId, reason: input.reason.trim() } }, manager);
      return { mutationAuthority: "verified", fingerprint, expiresAt: proof.expiresAt, alreadyImported: false };
    });
  }
}
