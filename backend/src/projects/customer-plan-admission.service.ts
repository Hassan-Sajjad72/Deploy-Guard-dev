import { ConfigService } from "@nestjs/config";
import { customerMutationAuthorized, validateCustomerAuthorityProof } from "../workspaces/customer-authority-proof";
import { HostingProfileRegistryService } from "../planning/hosting-profile-registry.service";
import { ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { EntityManager } from "typeorm";
import { DeploymentPlan, DeploymentPlanDecision } from "../planning/deployment-plan.entity";
import { deploymentConfigurationFingerprint } from "../planning/deployment-configuration";
import { hostingCatalog, planFingerprint } from "../planning/deployment-plan";
import { AwsAccountBinding } from "../workspaces/aws-account-binding.entity";
import { canAccessProject, canApproveProject } from "../workspaces/project-access";
import { validateAgencyProjectScope } from "../workspaces/agency-project-scope";
import { User } from "../users/user.entity";
import { canonicalEnvironmentName } from "./canonical-environment";
import { Project } from "./project.entity";
import { ProjectDeployableService } from "./project-deployable-service.entity";
import { ProjectEnvironmentVariable } from "./project-environment-variable.entity";
import { ProjectDatabaseTier } from "./project-database-tier.entity";
import type { CustomerExecutionContext } from "./customer-execution-context";

@Injectable()
export class CustomerPlanAdmissionService {
  constructor(private readonly profiles: HostingProfileRegistryService, private readonly config: ConfigService) {}
  async context(manager: EntityManager, user: User, project: Project, planId: string, fingerprint: string): Promise<Omit<CustomerExecutionContext, "credentials">> {
    if (project.executionMode !== "customer" || !project.organizationId || project.deletionIntentId) throw new ConflictException("This project cannot enter customer-account execution.");
    const memberships = await manager.query(`SELECT m.organization_id AS "organizationId", m.role, o.archived_at AS "archivedAt" FROM organization_memberships m JOIN organizations o ON o.id = m.organization_id WHERE m.organization_id = $1 AND m.user_id = $2`, [project.organizationId, user.id]);
    if (!canAccessProject({ ...user, organizationMemberships: memberships }, project, true)) throw new ForbiddenException("A current workspace engineer, administrator or owner is required to execute a deployment.");
    const plan = await manager.getRepository(DeploymentPlan).findOneBy({ id: planId, projectId: project.id, organizationId: project.organizationId });
    const decision = await manager.getRepository(DeploymentPlanDecision).findOneBy({ planId });
    if (!plan || !decision) throw new NotFoundException("Approved deployment plan not found.");
    if (plan.fingerprint !== fingerprint || planFingerprint(plan.content) !== fingerprint || decision.fingerprint !== fingerprint || decision.decision !== "approved" || decision.operationId !== plan.content.operationId || decision.environment !== canonicalEnvironmentName(project) || Number(decision.monthlyBudgetUsd) !== plan.content.assumptions.monthlyBudgetUsd || plan.content.status !== "review_required" || plan.content.blockers.length) throw new ConflictException("Deployment approval does not match the immutable plan, operation, environment and budget.");
    const approvers = await manager.query(`SELECT m.organization_id AS "organizationId", m.role, o.archived_at AS "archivedAt" FROM organization_memberships m JOIN organizations o ON o.id = m.organization_id WHERE m.organization_id = $1 AND m.user_id = $2`, [project.organizationId, decision.actorUserId]);
    if (!canApproveProject({ ...user, id: decision.actorUserId, organizationMemberships: approvers }, project)) throw new ConflictException("The deployment approver no longer has authority in this workspace.");
    const selected = plan.content.comparison.options.find((item) => item.id === plan.content.selectedProfile);
    if (plan.content.selectedProfile !== "ecs_fargate" || !this.profiles.available(plan.content.selectedProfile, plan.content.ownership.region) || !selected?.eligible || selected.cost.status !== "complete" || typeof selected.cost.monthlyUsd !== "number" || !Number.isFinite(selected.cost.monthlyUsd) || selected.cost.monthlyUsd < 0 || selected.cost.monthlyUsd > plan.content.assumptions.monthlyBudgetUsd || !selected.cost.estimatedAt || !Number.isFinite(Date.parse(selected.cost.estimatedAt)) || Date.now() - Date.parse(selected.cost.estimatedAt) > 86400000 || Date.parse(selected.cost.estimatedAt) > Date.now()) throw new ConflictException("The approved hosting profile or current itemized budget evidence is unavailable.");
    const currentProfile = this.profiles.catalog(plan.content.ownership.region).find((profile) => profile.id === plan.content.selectedProfile);
    if (!selected.verification?.fingerprint || currentProfile?.verification.fingerprint !== selected.verification.fingerprint) throw new ConflictException("Final provider evidence changed after plan approval.");
    const infrastructure = plan.content.infrastructure;
    if (!infrastructure || !/^vpc-[0-9a-f]{8}(?:[0-9a-f]{9})?$/.test(infrastructure.vpcId) || !Array.isArray(infrastructure.publicSubnetIds) || infrastructure.publicSubnetIds.length < 2 || infrastructure.publicSubnetIds.length > 6 || new Set(infrastructure.publicSubnetIds).size !== infrastructure.publicSubnetIds.length || infrastructure.publicSubnetIds.some((id) => !/^subnet-[0-9a-f]{8}(?:[0-9a-f]{9})?$/.test(id)) || !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(infrastructure.terraformStateBucket)) throw new ConflictException("A sealed customer-owned network and state-storage preview is required.");
    const ownership = plan.content.ownership;
    if (ownership.organizationId !== project.organizationId || ownership.environment !== canonicalEnvironmentName(project)) throw new ConflictException("Deployment plan workspace or environment ownership changed.");
    if (project.awsAccountBindingId && project.awsAccountBindingId !== ownership.bindingId) throw new ConflictException("Project AWS binding changed after approval.");
    if (project.clientId || project.engagementId) await validateAgencyProjectScope(manager, project.organizationId, { ...project, awsAccountBindingId: ownership.bindingId });
    const binding = await manager.getRepository(AwsAccountBinding).findOneBy({ id: ownership.bindingId, organizationId: project.organizationId });
    if (!binding || binding.verificationStatus !== "verified" || !customerMutationAuthorized(this.config, binding, project.id) || binding.verificationVersion !== ownership.bindingVersion || binding.accountId !== ownership.accountId || binding.roleArn !== ownership.roleArn || !binding.regions.includes(ownership.region)) throw new ConflictException("Customer account authorization differs from the approved plan.");
    const boundary = infrastructure.executionRolePermissionsBoundaryArn;
    if (!boundary || boundary !== validateCustomerAuthorityProof(this.config, binding.verificationEvidence?.authorityProof, binding, project.id)?.executionRoleBoundaryArns[project.id]) throw new ConflictException("A signed customer ECS task-role permissions boundary must be sealed in the plan.");
    const services = await manager.getRepository(ProjectDeployableService).find({ where: { projectId: project.id }, order: { position: "ASC" } });
    const variables = await manager.getRepository(ProjectEnvironmentVariable).createQueryBuilder("variable").addSelect("variable.value").where("variable.projectId = :projectId AND variable.environment = :environment AND variable.isActive = true", { projectId: project.id, environment: canonicalEnvironmentName(project) }).orderBy("variable.id", "ASC").getMany();
    const database = await manager.getRepository(ProjectDatabaseTier).findOneBy({ projectId: project.id });
    if (deploymentConfigurationFingerprint(project, services, variables, database, binding) !== plan.content.configurationFingerprint) throw new ConflictException("Project source, topology, configuration or AWS binding changed after approval.");
    return { organizationId: project.organizationId, bindingId: binding.id, bindingVersion: binding.verificationVersion, roleArn: binding.roleArn,
      projectId: project.id, operationId: plan.content.operationId, environmentName: ownership.environment, accountId: ownership.accountId, region: ownership.region,
      planId, planFingerprint: fingerprint, configurationFingerprint: plan.content.configurationFingerprint, sourceSha: plan.content.repository.sourceSha,
      deploymentAction: plan.content.deploymentAction || "deploy", ...(plan.content.lifecycle ? { lifecycle: plan.content.lifecycle } : {}), ...(plan.content.retry ? { retry: plan.content.retry } : {}), assumptions: plan.content.assumptions, buildTargetFingerprints: plan.content.services.map((service) => ({ serviceId: service.id, fingerprint: service.buildTarget.fingerprint })), requirementFingerprint: plan.content.requirements.fingerprint, ...infrastructure, executionRolePermissionsBoundaryArn: boundary };
  }
}
